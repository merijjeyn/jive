// Tests never read the developer's own ~/.config/jive/models.json; child processes inherit this.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.JIVE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "jive-test-config-"));
