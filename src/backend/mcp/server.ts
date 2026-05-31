#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { openDatabase } from "../db/database.js";
import { exportMarkdown, importMarkdown } from "../importExport/markdown.js";
import { exportOpml, importOpml } from "../importExport/opml.js";
import { OutlinerService } from "../services/outliner.js";

const service = new OutlinerService(openDatabase());
service.ensureSeedData();

const server = new McpServer({
  name: "openoutliner",
  version: "0.1.0"
});

registerTool(
  "list_workspaces",
  "List local OpenOutliner workspaces.",
  {},
  async () => service.listWorkspaces()
);

registerTool(
  "search_nodes",
  "Search outline nodes by title or body.",
  {
    query: z.string().describe("Search query"),
    workspaceId: z.string().optional().describe("Optional workspace ID"),
    limit: z.number().optional().describe("Maximum result count")
  },
  async ({ query, workspaceId, limit }) => service.searchNodes(query, workspaceId, limit)
);

registerTool(
  "read_node",
  "Read one outline node.",
  { id: z.string().describe("Node ID") },
  async ({ id }) => service.getNode(id)
);

registerTool(
  "get_children",
  "List direct children for a node.",
  { id: z.string().describe("Parent node ID") },
  async ({ id }) => service.listChildren(id)
);

registerTool(
  "read_tree",
  "Read a node subtree, including tags and field values.",
  { id: z.string().describe("Root node ID") },
  async ({ id }) => service.getTree(id)
);

registerTool(
  "create_node",
  "Create a child node.",
  {
    parentId: z.string().describe("Parent node ID"),
    title: z.string().describe("Node title"),
    body: z.string().optional().describe("Node body"),
    position: z.number().optional().describe("Sibling position")
  },
  async input => service.createNode(input)
);

registerTool(
  "edit_node",
  "Edit node title, body, done, or collapsed state.",
  {
    id: z.string().describe("Node ID"),
    title: z.string().optional(),
    body: z.string().optional(),
    done: z.boolean().optional(),
    collapsed: z.boolean().optional()
  },
  async ({ id, ...input }) => service.updateNode(id, input)
);

registerTool(
  "move_node",
  "Move a node under a new parent at an optional position.",
  {
    id: z.string().describe("Node ID"),
    parentId: z.string().describe("New parent node ID"),
    position: z.number().optional().describe("Sibling position")
  },
  async ({ id, parentId, position }) => service.moveNode(id, parentId, position)
);

registerTool(
  "delete_node",
  "Soft-delete a node subtree.",
  { id: z.string().describe("Node ID") },
  async ({ id }) => service.deleteNode(id)
);

registerTool(
  "list_tags",
  "List tags for a workspace.",
  { workspaceId: z.string().describe("Workspace ID") },
  async ({ workspaceId }) => service.listTags(workspaceId)
);

registerTool(
  "create_tag",
  "Create or return an existing tag.",
  {
    workspaceId: z.string(),
    name: z.string(),
    color: z.string().optional()
  },
  async ({ workspaceId, name, color }) => service.createTag(workspaceId, name, color)
);

registerTool(
  "set_node_tag",
  "Attach a tag to a node.",
  {
    nodeId: z.string(),
    name: z.string()
  },
  async ({ nodeId, name }) => service.setNodeTag(nodeId, name)
);

registerTool(
  "create_field_definition",
  "Create a typed field definition for a tag.",
  {
    workspaceId: z.string(),
    tagId: z.string(),
    name: z.string(),
    type: z.enum(["text", "number", "date", "checkbox", "select"]),
    options: z.string().optional()
  },
  async input => service.createFieldDefinition(input)
);

registerTool(
  "set_field_value",
  "Set a node field value.",
  {
    nodeId: z.string(),
    fieldId: z.string(),
    value: z.string()
  },
  async ({ nodeId, fieldId, value }) => service.setFieldValue(nodeId, fieldId, value)
);

registerTool(
  "import_markdown",
  "Import Markdown bullets/headings into a workspace.",
  {
    workspaceId: z.string(),
    parentId: z.string().optional(),
    content: z.string()
  },
  async input => importMarkdown(service, input)
);

registerTool(
  "export_markdown",
  "Export a workspace as Markdown.",
  { workspaceId: z.string() },
  async ({ workspaceId }) => exportMarkdown(service, workspaceId)
);

registerTool(
  "import_opml",
  "Import OPML into a workspace.",
  {
    workspaceId: z.string(),
    parentId: z.string().optional(),
    content: z.string()
  },
  async input => importOpml(service, input)
);

registerTool(
  "export_opml",
  "Export a workspace as OPML.",
  { workspaceId: z.string() },
  async ({ workspaceId }) => exportOpml(service, workspaceId)
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("OpenOutliner MCP server is running.");
}

function registerTool(
  name: string,
  description: string,
  inputSchema: z.ZodRawShape,
  handler: (input: any) => Promise<unknown> | unknown
): void {
  server.registerTool(name, { description, inputSchema }, async input => {
    const result = await handler(input);
    return {
      content: [
        {
          type: "text" as const,
          text: typeof result === "string" ? result : JSON.stringify(result, null, 2)
        }
      ]
    };
  });
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
