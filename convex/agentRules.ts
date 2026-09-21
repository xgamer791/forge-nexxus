import { FED } from "./fed";
import { FORGE_MD } from "./forgeMd";

export { FED, FORGE_MD };

if (!FORGE_MD.trim() || !FED.trim()) {
  throw new Error("FORGE_MD and FED must both be present");
}

export function standingSystemMessages(): { role: "system"; content: string }[] {
  return [
    { role: "system", content: FORGE_MD },
    { role: "system", content: FED },
  ];
}
