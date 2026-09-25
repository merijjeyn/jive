import type { SelectOption } from "@opentui/core";
import type { ModelOption } from "../../core/types.ts";
import { palette } from "../theme.ts";

export function ModelPicker(props: {
  models: ModelOption[];
  current: string;
  width: number;
  height: number;
  onChoose: (id: string) => void;
}) {
  // One row per model, name only: ids, context sizes and effort levels stay
  // out of the list so it reads at a glance. Providers without credentials are
  // left out, and the provider is named only when more than one is usable.
  const models = props.models.filter((m) => m.available !== false || m.id === props.current);
  const providers = new Set(models.map((m) => m.provider ?? m.id));
  const label = (m: ModelOption) => providers.size > 1 && m.providerName ? `${m.name} · ${m.providerName}` : m.name;
  const options: SelectOption[] = models.map((m) => ({
    name: m.id === props.current ? `● ${label(m)}` : `  ${label(m)}`,
    description: "",
    value: m.id,
  }));
  const selectedIndex = Math.max(0, models.findIndex((m) => m.id === props.current));
  const boxWidth = Math.min(props.width - 4, 56);
  const boxHeight = Math.min(props.height - 4, (options.length || 3) + 4);
  return (
    <box
      position="absolute"
      top={Math.max(0, Math.floor((props.height - boxHeight) / 2))}
      left={Math.max(0, Math.floor((props.width - boxWidth) / 2))}
      width={boxWidth}
      height={boxHeight}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={palette.accent}
      backgroundColor={palette.surfaceRaised}
      title=" model "
      titleColor={palette.accent}
      zIndex={20}
      paddingX={1}
    >
      {options.length === 0 ? (
        <text fg={palette.textDim}>No provider has credentials. Set a key such as OPENROUTER_API_KEY, or use /model provider:id.</text>
      ) : (
        <select
          focused
          options={options}
          selectedIndex={selectedIndex}
          backgroundColor={palette.surfaceRaised}
          focusedBackgroundColor={palette.surfaceRaised}
          textColor={palette.text}
          focusedTextColor={palette.text}
          selectedBackgroundColor={palette.accentSoft}
          selectedTextColor={palette.text}
          showDescription={false}
          showScrollIndicator
          wrapSelection
          onSelect={(_index, option) => {
            if (option && typeof option.value === "string") props.onChoose(option.value);
          }}
          flexGrow={1}
        />
      )}
      <text fg={palette.textFaint} wrapMode="none">
        ↑/↓ · Enter · Esc · /model provider:id for others
      </text>
    </box>
  );
}
