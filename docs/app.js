const SURFACES = [
  { id: "site", label: "Public site" },
  { id: "tool", label: "Internal tool" },
  { id: "field", label: "Field kit" },
  { id: "cli", label: "CLI bench" },
];

const STACKS = [
  { id: "static", label: "Static pages" },
  { id: "node", label: "Node" },
  { id: "python", label: "Python" },
  { id: "mixed", label: "Mixed" },
];

const HEATS = [
  { id: "spike", label: "Spike" },
  { id: "sprint", label: "Sprint" },
  { id: "campaign", label: "Campaign" },
];

const EXAMPLES = [
  {
    label: "Tool library",
    brief: "A weekend tool library for the block — who has the ladder, who wants it back, and when it is due.",
    surface: "tool",
    stack: "static",
    heat: "sprint",
  },
  {
    label: "Bike shop wall",
    brief: "A bike shop wall of open jobs, parts waiting, and who promised what by Friday.",
    surface: "tool",
    stack: "node",
    heat: "campaign",
  },
  {
    label: "Saturday league",
    brief: "A roster and field-notes kit for a Saturday rec league: who plays, who is out, what the pitch looked like.",
    surface: "field",
    stack: "static",
    heat: "spike",
  },
  {
    label: "Docs gate",
    brief: "A public gate for a small workshop: what we make, one proof, and how to book a bench.",
    surface: "site",
    stack: "static",
    heat: "spike",
  },
];

const MODULES = {
  site: [
    { id: "gate", name: "Gate", cut: "The first screen states who it is for and what happens if they stay." },
    { id: "story", name: "Story", cut: "One concrete example, not a feature list." },
    { id: "proof", name: "Proof", cut: "A real artifact: a number, a sample, or a named result." },
    { id: "ask", name: "Ask", cut: "A single next step. No second door on the first page." },
    { id: "archive", name: "Archive", cut: "A quiet place for the rest so the first page stays short." },
  ],
  tool: [
    { id: "inbox", name: "Inbox", cut: "Every request lands in one queue with a name and a due mark." },
    { id: "board", name: "Board", cut: "Status is visible without opening a record." },
    { id: "record", name: "Record", cut: "The object is small: owner, state, next action, last touch." },
    { id: "export", name: "Export", cut: "A copy-out that a person can paste into a message or a sheet." },
    { id: "audit", name: "Audit", cut: "A short trail of who changed what, enough to settle an argument." },
  ],
  field: [
    { id: "capture", name: "Capture", cut: "A fast form that works with thumbs and bad light." },
    { id: "roster", name: "Roster", cut: "Who is here, who is out, and who is covering." },
    { id: "map", name: "Map", cut: "Place matters: a pitch, a shop floor, a block — keep it named." },
    { id: "sync", name: "Sync", cut: "Assume the radio dies. The last good copy is on the device." },
    { id: "handoff", name: "Handoff", cut: "The next person can start without a briefing call." },
  ],
  cli: [
    { id: "parse", name: "Parse", cut: "Flags and files fail loudly, with an example of the right shape." },
    { id: "run", name: "Run", cut: "One command does the job. A second command explains it." },
    { id: "report", name: "Report", cut: "Stdout is a plate a human can read, not a dump." },
    { id: "cache", name: "Cache", cut: "Repeat work is cheap. Spell out where the cache lives." },
    { id: "hook", name: "Hook", cut: "A way to bolt this into a larger script without rewriting it." },
  ],
};

const STACK_NOTES = {
  static: "Ship as files a host can serve. No login, no database, no deploy ritual beyond a folder.",
  node: "Keep the server thin: read, write, list. Put the judgment in the page, not in a framework garden.",
  python: "One script or a small package. Prefer a folder you can run without a poetry novel.",
  mixed: "Static face, small worker behind it. Draw the seam on day one so the page can exist alone.",
};

const HEAT_NOTES = {
  spike: {
    hours: [
      "Write the brief on the plate and freeze the first three modules.",
      "Build the thinnest path a stranger can finish.",
      "Cut anything that needs an account, a key, or a second page of setup.",
    ],
    risks: [
      "A spike dies when it starts collecting future rooms.",
      "If the first path needs a seed file, write that file by hand.",
    ],
    order: 3,
  },
  sprint: {
    hours: [
      "Stand the nexus map on a real record — even ten rows is enough.",
      "Make status visible before you make it pretty.",
      "Add one export so the work can leave the page.",
    ],
    risks: [
      "Owners go missing if the record has no name field.",
      "A week disappears into empty states. Fill the board with sample work first.",
    ],
    order: 5,
  },
  campaign: {
    hours: [
      "Lock the object model before the third view.",
      "Name the weekly loop: who looks, who updates, who closes.",
      "Schedule a cut date for the first public or shared plate.",
    ],
    risks: [
      "Campaigns bloat when every request becomes a module.",
      "If two stacks are in play, write the seam and a fallback when the worker is down.",
    ],
    order: 5,
  },
};

const NODE_LAYOUT = [
  { x: 70, y: 78 },
  { x: 250, y: 36 },
  { x: 430, y: 92 },
  { x: 340, y: 196 },
  { x: 110, y: 188 },
];

const LINKS = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 0],
  [1, 3],
];

const STOP = new Set([
  "a", "an", "the", "and", "or", "to", "for", "of", "in", "on", "with", "my", "our",
  "your", "i", "we", "want", "need", "build", "make", "app", "that", "this", "from",
  "into", "who", "what", "when", "it", "is", "are", "be", "a",
]);

const state = {
  brief: EXAMPLES[0].brief,
  surface: "tool",
  stack: "static",
  heat: "sprint",
  project: "",
  nameLocked: false,
  stamp: 0,
  dropped: new Set(),
  hot: null,
};

const els = {
  brief: document.querySelector("#brief"),
  project: document.querySelector("#project"),
  count: document.querySelector("#brief-count"),
  examples: document.querySelector("#examples"),
  surface: document.querySelector("#surface"),
  stack: document.querySelector("#stack"),
  heat: document.querySelector("#heat"),
  stamp: document.querySelector("#stamp"),
  copy: document.querySelector("#copy"),
  status: document.querySelector("#copy-status"),
  serial: document.querySelector("#serial"),
  name: document.querySelector("#plate-name"),
  mission: document.querySelector("#mission"),
  tags: document.querySelector("#tags"),
  nexus: document.querySelector("#nexus"),
  anvil: document.querySelector("#anvil"),
  order: document.querySelector("#order"),
  hours: document.querySelector("#hours"),
  risks: document.querySelector("#risks"),
};

function hash(text) {
  let value = 2166136261;
  for (const char of text) {
    value ^= char.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function wordsFrom(brief) {
  return (brief.toLowerCase().match(/[a-z0-9]+/g) || []).filter((word) => !STOP.has(word) && word.length > 2);
}

function titleFrom(brief) {
  const words = wordsFrom(brief).slice(0, 3);
  if (!words.length) return "Untitled Forge";
  return words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

function clip(brief) {
  const clean = brief.trim().replace(/\s+/g, " ");
  if (!clean) return "a job that already has a name in the room";
  return clean.length > 140 ? `${clean.slice(0, 137)}…` : clean;
}

function activeModules() {
  return MODULES[state.surface].filter((module) => !state.dropped.has(module.id));
}

function missionLine() {
  const name = els.project.value.trim() || titleFrom(state.brief);
  const subject = clip(state.brief);
  const bySurface = {
    site: `${name} is a public surface for ${subject}. The first cut is a page a stranger can finish.`,
    tool: `${name} is an internal bench for ${subject}. The first cut is the daily loop: intake, status, handoff.`,
    field: `${name} is a field kit for ${subject}. The first cut works when the signal is bad and the hands are full.`,
    cli: `${name} is a command bench for ${subject}. The first cut is one invocation that prints a plate a person can use.`,
  };
  const flavors = [
    bySurface[state.surface],
    `${name} starts as a nexus of a few named modules — not a platform. Hold the work to ${subject}.`,
    `Treat ${name} as a plate you can stamp this week. If a piece does not serve ${subject}, it waits.`,
  ];
  return flavors[state.stamp % flavors.length];
}

function buildOrder(modules) {
  const stack = STACK_NOTES[state.stack];
  const limit = HEAT_NOTES[state.heat].order;
  const steps = modules.map((module, index) => {
    if (index === 0) return `Cut ${module.name}: ${module.cut}`;
    return `Stand ${module.name} next, only as far as it feeds the first path.`;
  });
  steps.splice(Math.min(2, steps.length), 0, stack);
  return steps.slice(0, limit);
}

function serial() {
  const value = hash(`${state.brief}|${state.surface}|${state.stack}|${state.heat}|${state.stamp}|${[...state.dropped].join(",")}`);
  return `FN-${value.toString(16).toUpperCase().padStart(4, "0").slice(0, 4)}`;
}

function setSegments(root, options, key) {
  root.replaceChildren();
  for (const option of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "segment";
    button.dataset.id = option.id;
    button.textContent = option.label;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", option.id === state[key] ? "true" : "false");
    button.addEventListener("click", () => {
      state[key] = option.id;
      if (key === "surface") {
        state.dropped.clear();
        state.hot = null;
      }
      renderSegments();
      renderPlate();
    });
    root.append(button);
  }
}

function renderSegments() {
  setSegments(els.surface, SURFACES, "surface");
  setSegments(els.stack, STACKS, "stack");
  setSegments(els.heat, HEATS, "heat");
}

function renderExamples() {
  els.examples.replaceChildren();
  for (const example of EXAMPLES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.textContent = example.label;
    button.setAttribute("aria-pressed", example.brief === state.brief ? "true" : "false");
    button.addEventListener("click", () => {
      state.brief = example.brief;
      state.surface = example.surface;
      state.stack = example.stack;
      state.heat = example.heat;
      state.nameLocked = false;
      state.dropped.clear();
      state.hot = null;
      els.brief.value = example.brief;
      renderSegments();
      renderExamples();
      renderPlate();
    });
    els.examples.append(button);
  }
}

function renderNexus(modules) {
  const all = MODULES[state.surface];
  const width = 520;
  const height = 260;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "nexus");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "group");
  svg.setAttribute("aria-label", "Nexus map");

  for (const [from, to] of LINKS) {
    const a = NODE_LAYOUT[from];
    const b = NODE_LAYOUT[to];
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("class", "link");
    line.setAttribute("x1", String(a.x + 70));
    line.setAttribute("y1", String(a.y + 16));
    line.setAttribute("x2", String(b.x + 70));
    line.setAttribute("y2", String(b.y + 16));
    svg.append(line);
  }

  all.forEach((module, index) => {
    const point = NODE_LAYOUT[index];
    const dropped = state.dropped.has(module.id);
    const hot = state.hot === module.id;
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute("class", `node${dropped ? " is-dropped" : ""}${hot ? " is-hot" : ""}`);
    group.setAttribute("tabindex", "0");
    group.setAttribute("role", "button");
    group.setAttribute(
      "aria-label",
      `${module.name}${dropped ? ", dropped from this cut" : ""}${hot ? ", on the anvil" : ""}`,
    );

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(point.x));
    rect.setAttribute("y", String(point.y));
    rect.setAttribute("width", "140");
    rect.setAttribute("height", "32");
    group.append(rect);

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", String(point.x + 12));
    text.setAttribute("y", String(point.y + 21));
    text.textContent = module.name;
    group.append(text);

    const activate = () => {
      if (state.hot === module.id) {
        if (state.dropped.has(module.id)) {
          state.dropped.delete(module.id);
          state.hot = module.id;
        } else if (modules.length > 2) {
          state.dropped.add(module.id);
          state.hot = module.id;
        }
      } else {
        state.hot = module.id;
      }
      renderPlate();
    };

    group.addEventListener("click", activate);
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });
    svg.append(group);
  });

  els.nexus.replaceChildren(svg);
}

function list(target, items) {
  target.replaceChildren();
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    target.append(li);
  }
}

function renderPlate() {
  state.brief = els.brief.value;
  els.count.textContent = String(state.brief.length);

  if (!state.nameLocked) {
    els.project.value = titleFrom(state.brief);
  }

  const name = els.project.value.trim() || "Untitled Forge";
  const modules = activeModules();
  const focused = MODULES[state.surface].find((module) => module.id === state.hot);
  const surface = SURFACES.find((item) => item.id === state.surface)?.label;
  const stack = STACKS.find((item) => item.id === state.stack)?.label;
  const heat = HEATS.find((item) => item.id === state.heat)?.label;

  els.serial.textContent = serial();
  els.name.textContent = name;
  els.mission.textContent = missionLine();
  els.tags.textContent = `${surface} · ${stack} · ${heat} · ${modules.length} modules`;
  renderNexus(modules);

  if (focused) {
    const status = state.dropped.has(focused.id) ? "Dropped from this cut." : "On this cut.";
    els.anvil.textContent = `${focused.name} — ${focused.cut} ${status} Click again to ${state.dropped.has(focused.id) ? "return it" : "drop it"}.`;
  } else {
    els.anvil.textContent = "No node on the anvil. Click a module to inspect it.";
  }

  list(els.order, buildOrder(modules));
  list(els.hours, HEAT_NOTES[state.heat].hours);
  list(els.risks, HEAT_NOTES[state.heat].risks);
}

function plateMarkdown() {
  const name = els.project.value.trim() || "Untitled Forge";
  const modules = activeModules();
  const lines = [
    `# ${name}`,
    "",
    `Forge Nexxus spec plate · ${els.serial.textContent}`,
    "",
    els.mission.textContent,
    "",
    `Surface / stack / heat: ${els.tags.textContent}`,
    "",
    "## Nexus",
    ...modules.map((module) => `- ${module.name} — ${module.cut}`),
    "",
    "## Build order",
    ...[...els.order.children].map((item, index) => `${index + 1}. ${item.textContent}`),
    "",
    "## First 48 hours",
    ...[...els.hours.children].map((item) => `- ${item.textContent}`),
    "",
    "## Watch-outs",
    ...[...els.risks.children].map((item) => `- ${item.textContent}`),
    "",
  ];
  return lines.join("\n");
}

function renderExamplesAndPlate() {
  renderExamples();
  renderPlate();
}

els.brief.addEventListener("input", () => {
  state.nameLocked = false;
  renderExamplesAndPlate();
});

els.project.addEventListener("input", () => {
  state.nameLocked = true;
  renderPlate();
});

els.stamp.addEventListener("click", () => {
  state.stamp += 1;
  renderPlate();
});

els.copy.addEventListener("click", async () => {
  const text = plateMarkdown();
  try {
    await navigator.clipboard.writeText(text);
    els.status.textContent = "Plate copied.";
    els.copy.textContent = "Copied";
  } catch {
    els.status.textContent = "Copy failed. Select the plate and copy it manually.";
    els.copy.textContent = "Copy failed";
  }
  window.setTimeout(() => {
    els.copy.textContent = "Copy plate";
  }, 1600);
});

renderSegments();
renderExamplesAndPlate();
