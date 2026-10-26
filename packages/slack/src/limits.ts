/** Slack Block Kit limits that this package checks. Lengths are in code points. */
export const LIMITS = {
  blocks: 50,
  headerText: 150,
  sectionText: 3000,
  sectionFields: 10,
  sectionFieldText: 2000,
  buttonText: 75,
  buttonValue: 2000,
  actionId: 255,
  // This spec's choice: Slack allows more but cuts notifications.
  fallbackText: 3000,
} as const;

/** A block. Only the fields the checks read are named; the rest is left alone. */
export interface SlackBlock {
  type?: string;
  block_id?: string;
  [key: string]: unknown;
}

export interface SlackMessage {
  text?: string;
  blocks?: SlackBlock[];
}

export interface Violation {
  /** Stable name of the broken limit, such as `section.text.max`. */
  rule: string;
  /** Where it is, such as `blocks[2].fields[0]`. */
  path: string;
  limit: number;
  actual: number;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const len = (s: unknown): number | undefined =>
  typeof s === "string" ? Array.from(s).length : undefined;

function textLen(textObj: unknown): number | undefined {
  return isObj(textObj) ? len(textObj.text) : undefined;
}

function over(
  out: Violation[],
  rule: string,
  path: string,
  limit: number,
  actual: number | undefined,
): void {
  if (actual !== undefined && actual > limit) out.push({ rule, path, limit, actual });
}

function checkButton(out: Violation[], button: Obj, path: string): void {
  over(out, "button.text.max", `${path}.text`, LIMITS.buttonText, textLen(button.text));
  over(out, "button.value.max", `${path}.value`, LIMITS.buttonValue, len(button.value));
  over(out, "action_id.max", `${path}.action_id`, LIMITS.actionId, len(button.action_id));
}

function checkBlock(out: Violation[], block: Obj, path: string): void {
  switch (block.type) {
    case "header":
      over(out, "header.text.max", `${path}.text`, LIMITS.headerText, textLen(block.text));
      break;
    case "section": {
      over(out, "section.text.max", `${path}.text`, LIMITS.sectionText, textLen(block.text));
      if (Array.isArray(block.fields)) {
        over(out, "section.fields.max", `${path}.fields`, LIMITS.sectionFields, block.fields.length);
        block.fields.forEach((f: unknown, i: number) =>
          over(
            out,
            "section.field.text.max",
            `${path}.fields[${i}]`,
            LIMITS.sectionFieldText,
            textLen(f),
          ),
        );
      }
      if (isObj(block.accessory) && block.accessory.type === "button") {
        checkButton(out, block.accessory, `${path}.accessory`);
      }
      break;
    }
    case "actions":
      if (Array.isArray(block.elements)) {
        block.elements.forEach((el: unknown, i: number) => {
          if (isObj(el) && el.type === "button") checkButton(out, el, `${path}.elements[${i}]`);
        });
      }
      break;
    default:
      // Unknown block types are left alone: no limit here is theirs to break.
      break;
  }
}

/** Returns the named limit violations of a message; an empty list means it fits. */
export function validateMessage(message: SlackMessage): Violation[] {
  const out: Violation[] = [];
  const blocks = Array.isArray(message.blocks) ? message.blocks : [];

  over(out, "blocks.max", "blocks", LIMITS.blocks, blocks.length);

  const seen = new Set<string>();
  const reported = new Set<string>();
  blocks.forEach((block, i) => {
    if (!isObj(block)) return;
    const path = `blocks[${i}]`;
    checkBlock(out, block, path);
    const id = block.block_id;
    if (typeof id === "string") {
      if (seen.has(id) && !reported.has(id)) {
        reported.add(id);
        out.push({ rule: "block_id.unique", path: `${path}.block_id`, limit: 1, actual: 2 });
      }
      seen.add(id);
    }
  });

  over(out, "text.max", "text", LIMITS.fallbackText, len(message.text));
  return out;
}
