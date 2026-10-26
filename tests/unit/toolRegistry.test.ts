/**
 * Step 3F.2 (2026-10-07) — proves src/ai/toolRegistry.ts is actually channel-independent, not
 * just named that way: no WhatsApp transport (Baileys/JID/pendingActions), no Web HTTP/session,
 * no board-navigation legacy assumptions. Also proves tools.ts's re-exports are the same objects
 * (not copies), and that the relocation changed nothing about the permission-filtering function
 * itself.
 *
 *   הועבר אחד-לאחד מ-scripts/test-tool-registry.ts (הוסר). רץ ב-npm test.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  isToolAllowedForUser as registryIsToolAllowedForUser,
  type ToolDefinition as RegistryToolDefinition,
} from "../../src/ai/toolRegistry.js";
import { isToolAllowedForUser as toolsIsToolAllowedForUser, tools as whatsappTools } from "../../src/integrations/claude/tools.js";
import { resolveUserByKey } from "../../src/identity/index.js";
import { logger } from "../../src/utils/logger.js";
import { assert } from "../helpers/check.js";


const __dirname = dirname(fileURLToPath(import.meta.url));
const registrySource = readFileSync(join(__dirname, "..", "..", "src", "ai", "toolRegistry.ts"), "utf-8");

function main() {
  logger.info("— src/ai/toolRegistry.ts: אין טרנספורט/ UI ספציפי-לערוץ —");

  const forbidden: [RegExp, string][] = [
    [/baileys/i, "Baileys (WhatsApp transport)"],
    [/\bjid\b/i, "JID (WhatsApp addressing)"],
    [/pendingAction/i, "pendingActions (WhatsApp confirmation transport)"],
    [/whatsapp\//i, "integrations/whatsapp/* import"],
    [/fromMe/i, "fromMe (WhatsApp inbound filter)"],
    [/req\s*:\s*IncomingMessage|currentUser\(/i, "Web HTTP/session (currentUser/IncomingMessage)"],
    [/chat_messages|appendChatTurn/i, "Web SQLite chat history"],
    [/actions\.push|refresh\(\)/i, "Web UI changelog/refresh side effects"],
    [/find_monday_board|list_monday_boards/i, "legacy board-navigation assumption"],
  ];
  for (const [pattern, label] of forbidden) {
    assert(!pattern.test(registrySource), `toolRegistry.ts לא מכיל ${label}`);
  }

  logger.info("— tools.ts's re-exports הם האובייקטים עצמם, לא עותקים —");
  assert(
    toolsIsToolAllowedForUser === registryIsToolAllowedForUser,
    "integrations/claude/tools.ts's isToolAllowedForUser === src/ai/toolRegistry.ts's isToolAllowedForUser — re-export אמיתי",
  );

  logger.info("— isToolAllowedForUser: ההתנהגות לא השתנתה (sanity, לא תחליף לבדיקות המלאות של test-whatsapp-agent-tools) —");
  const moti = resolveUserByKey("moti")!;
  // finance בלי task:update_own (מאז 2026-10-26 ל-finance האמיתי יש אותה — מוסרת כאן לכיסוי הדחייה)
  const goldiReal = resolveUserByKey("goldi")!;
  const goldi = { ...goldiReal, permissions: goldiReal.permissions.filter((p) => p !== "task:update_own") };
  const markDone = whatsappTools.find((t) => t.name === "mark_done")! as unknown as RegistryToolDefinition;
  const legacyStatus = whatsappTools.find((t) => t.name === "update_monday_task_status")! as unknown as RegistryToolDefinition;
  assert(registryIsToolAllowedForUser(markDone, moti), "mark_done (agentTool-backed): מוטי מורשה");
  assert(!registryIsToolAllowedForUser(markDone, goldi), "mark_done (agentTool-backed): גולדי לא מורשית");
  assert(registryIsToolAllowedForUser(legacyStatus, moti), "update_monday_task_status (legacy, requiredPermission בודד): מוטי מורשה");
  assert(!registryIsToolAllowedForUser(legacyStatus, goldi), "update_monday_task_status (legacy): גולדי לא מורשית (task:update_own)");
  assert(!registryIsToolAllowedForUser(markDone, null), "null user: אף פעם לא מורשה, גם לכלי agentTool-backed");

}

await main();
