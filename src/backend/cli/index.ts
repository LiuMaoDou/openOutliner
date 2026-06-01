#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { openDatabase } from "../db/database.js";
import { exportMarkdown, importMarkdown } from "../importExport/markdown.js";
import { exportOpml, importOpml } from "../importExport/opml.js";
import { OutlinerService } from "../services/outliner.js";

const program = new Command();

program
  .name("openoutliner")
  .description("CLI for the local OpenOutliner workspace")
  .version("0.1.0")
  .option("--db <path>", "SQLite database path");

function getService(): OutlinerService {
  const dbPath = program.opts<{ db?: string }>().db;
  const service = new OutlinerService(openDatabase(dbPath));
  service.ensureSeedData();
  return service;
}

const workspace = program.command("workspace").description("Manage workspaces");

workspace
  .command("list")
  .description("List workspaces")
  .action(() => print(getService().listWorkspaces()));

workspace
  .command("create")
  .description("Create a workspace")
  .requiredOption("--name <name>", "Workspace name")
  .option("--icon <icon>", "Lucide icon name")
  .action(options => print(getService().createWorkspace(options.name, options.icon)));

const node = program.command("node").description("Manage outline nodes");

node
  .command("get")
  .argument("<id>")
  .description("Get a node")
  .action(id => print(getService().getNode(id)));

node
  .command("children")
  .argument("<id>")
  .description("List child nodes")
  .action(id => print(getService().listChildren(id)));

node
  .command("tree")
  .argument("<id>")
  .description("Read a node subtree")
  .action(id => print(getService().getTree(id)));

node
  .command("create")
  .description("Create a node")
  .requiredOption("--parent <id>", "Parent node ID")
  .requiredOption("--title <title>", "Node title")
  .option("--body <body>", "Node body", "")
  .option("--position <n>", "Sibling position", value => Number(value))
  .action(options =>
    print(
      getService().createNode({
        parentId: options.parent,
        title: options.title,
        body: options.body,
        position: options.position
      })
    )
  );

node
  .command("update")
  .argument("<id>")
  .description("Update a node")
  .option("--title <title>", "Node title")
  .option("--body <body>", "Node body")
  .option("--done <done>", "Done state: true or false", parseBoolean)
  .option("--collapsed <collapsed>", "Collapsed state: true or false", parseBoolean)
  .action((id, options) => print(getService().updateNode(id, options)));

node
  .command("move")
  .argument("<id>")
  .description("Move a node")
  .requiredOption("--parent <id>", "New parent node ID")
  .option("--position <n>", "Sibling position", value => Number(value))
  .action((id, options) => print(getService().moveNode(id, options.parent, options.position)));

node
  .command("delete")
  .argument("<id>")
  .description("Soft-delete a node subtree")
  .action(id => print(getService().deleteNode(id)));

program
  .command("search")
  .argument("<query>")
  .description("Search nodes")
  .option("--workspace <id>", "Workspace ID")
  .option("--limit <n>", "Result limit", value => Number(value), 25)
  .action((query, options) => print(getService().searchNodes(query, options.workspace, options.limit)));

const tag = program.command("tag").description("Manage tags");

tag
  .command("list")
  .requiredOption("--workspace <id>", "Workspace ID")
  .action(options => print(getService().listTags(options.workspace)));

tag
  .command("set")
  .requiredOption("--node <id>", "Node ID")
  .requiredOption("--name <name>", "Tag name")
  .action(options => print(getService().setNodeTag(options.node, options.name)));

const importCommand = program.command("import").description("Import outlines");

importCommand
  .command("markdown")
  .argument("<file>")
  .requiredOption("--workspace <id>", "Workspace ID")
  .option("--parent <id>", "Parent node ID")
  .action((file, options) =>
    print(
      importMarkdown(getService(), {
        workspaceId: options.workspace,
        parentId: options.parent,
        content: readFileSync(file, "utf8")
      })
    )
  );

importCommand
  .command("opml")
  .argument("<file>")
  .option("--workspace <id>", "Workspace ID. If omitted, creates a workspace from the OPML title.")
  .option("--parent <id>", "Parent node ID")
  .action((file, options) =>
    print(
      importOpml(getService(), {
        workspaceId: options.workspace,
        parentId: options.parent,
        content: readFileSync(file, "utf8")
      })
    )
  );

const exportCommand = program.command("export").description("Export outlines");

exportCommand
  .command("markdown")
  .requiredOption("--workspace <id>", "Workspace ID")
  .option("--out <file>", "Output file")
  .action(options => output(exportMarkdown(getService(), options.workspace), options.out));

exportCommand
  .command("opml")
  .requiredOption("--workspace <id>", "Workspace ID")
  .option("--out <file>", "Output file")
  .action(options => output(exportOpml(getService(), options.workspace), options.out));

program.parseAsync().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function output(content: string, file?: string): void {
  if (file) {
    writeFileSync(file, content, "utf8");
  } else {
    process.stdout.write(content);
  }
}

function parseBoolean(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("Boolean values must be true or false.");
}
