import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { readApiKey } from "./key.ts";
import { createReclaimClient } from "./reclaim.ts";
import { createServer } from "./tools.ts";

const reclaim = createReclaimClient(readApiKey());
serveStdio(() => createServer(reclaim));
