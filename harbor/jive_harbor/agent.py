"""Harbor 0.23 installed-agent integration; Taskground remains independent."""

import json
from pathlib import Path
from typing import Literal

from pydantic import Field
from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from .metrics import write_outputs
from .source import read_manifest


class JiveOptions(InstalledAgentOptions):
    source_bundle: str = Field(description="Immutable bundle created by python -m jive_harbor.source")
    effort: Literal["none", "minimal", "low", "medium", "high", "xhigh", "max"] | None = None
    demo: bool = Field(default=False, description="Run Jive's deterministic graph fixture without model calls")


class JiveAgent(BaseInstalledAgent):
    capabilities = AgentCapabilities(atif=True)
    MODEL_CONNECTION = ModelConnectionSpec(default_provider="openrouter")
    options_model = JiveOptions
    options: JiveOptions

    @staticmethod
    def name() -> str:
        return "jive"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.bundle = Path(self.options.source_bundle).expanduser().resolve()
        self.manifest = read_manifest(self.bundle)
        self._version = f"{self.manifest['version']}+{self.manifest['source_hash'][:12]}"

    async def install(self, environment: BaseEnvironment) -> None:
        # Initial backend support: Linux Debian/Ubuntu task images, root available for setup.
        await self.exec_as_root(environment, """
set -eu
if ! command -v python3 >/dev/null || ! command -v curl >/dev/null || ! command -v unzip >/dev/null || ! command -v git >/dev/null; then
  command -v apt-get >/dev/null || { echo 'Jive needs python3, curl, unzip, git and a glibc Linux image'; exit 1; }
  apt-get update -qq
  apt-get install -y -qq python3 curl unzip git ca-certificates
fi
if ! command -v bun >/dev/null || [ "$(bun --version)" != '1.4.2' ]; then
  case "$(uname -m)" in x86_64) arch=x64;; aarch64|arm64) arch=aarch64;; *) exit 1;; esac
  curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-$arch.zip" -o /tmp/jive-bun.zip
  unzip -oq /tmp/jive-bun.zip -d /opt/jive-bun
  ln -sf "/opt/jive-bun/bun-linux-$arch/bun" /usr/local/bin/bun
  rm /tmp/jive-bun.zip
fi
mkdir -p /opt/jive
"""
        )
        await environment.upload_file(self.bundle, "/tmp/jive-source.tar")
        await self.exec_as_root(environment, "tar -xf /tmp/jive-source.tar -C /opt/jive && rm /tmp/jive-source.tar && cd /opt/jive && bun install --frozen-lockfile --ignore-scripts && chmod -R a+rX /opt/jive")
        await environment.upload_file(Path(__file__).with_name("runtime.py"), "/opt/jive-harbor-runtime.py")
        await self.exec_as_root(environment, "chmod a+r /opt/jive-harbor-runtime.py")
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "source.json").write_text(json.dumps(self.manifest, indent=2))

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        if not self.options.demo and not self.model_name:
            raise ValueError("Select a Jive planner model with --model")
        env = {}
        for key in ("OPENROUTER_API_KEY", "JEV_API_TOKEN", "TYPESAFE_API_KEY", "JEV_MODEL"):
            value = self._get_env(key)
            if value:
                env[key] = value
        if not self.options.demo and not env.get("OPENROUTER_API_KEY"):
            raise ValueError("Set OPENROUTER_API_KEY in the environment or with --ae")
        config = {"logs": str(self.environment_logs_dir), "instruction": instruction,
                  "model": self.model_name, "effort": self.options.effort, "demo": self.options.demo}
        await self._upload_config_text(environment, content=json.dumps(config),
                                       remote_path="/tmp/jive-harbor-run.json", filename="run.json")
        await self.exec_as_agent(environment, "python3 /opt/jive-harbor-runtime.py /tmp/jive-harbor-run.json", env=env)
        # Harbor invokes populate_context_post_run after syncing logs, including failed trials.

    def populate_context_post_run(self, context: AgentContext) -> None:
        metrics = write_outputs(self.logs_dir, self.model_name, self._version)
        context.n_input_tokens = metrics["planner_input_tokens"]
        context.n_output_tokens = metrics["planner_output_tokens"]
        context.n_cache_tokens = metrics["planner_cached_tokens"]
        context.metadata = {"jive": metrics, "source": self.manifest}
