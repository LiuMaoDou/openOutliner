import { describe, expect, it } from "vitest";
import { rollbackTreeMutation } from "../src/web/optimisticRollback";
import { shouldCopyNodes } from "../src/web/selectionOwnership";
import { moveNode, removeNode, updateNode, type FlatNodeData, type FlatTreeState } from "../src/web/flatTree";
function tree(): FlatTreeState {
  const node = (id: string, parentId: string | null, position: number, childIds: string[] = []): FlatNodeData => ({
    id, parentId, position, childIds, workspaceId: "w", title: id, body: "", dueDate: null,
    done: false, collapsed: false, createdAt: "", updatedAt: "", tags: [], fieldValues: []
  });
  return {rootId: "r", nodes: {r: node("r", null, 0, ["a", "b", "c"]), a: node("a", "r", 0), b: node("b", "r", 1), c: node("c", "r", 2)}};
}
describe("context-aware optimistic inverses", () => {
  it("undoes an isolated failed deletion", () => {
    const before=tree(), applied=removeNode(before,"a");
    expect(rollbackTreeMutation(before,applied,applied)).toEqual(before);
  });
  it("preserves later title/body edits when reverting a failed move", () => {
    const before=tree(), applied=moveNode(before,"a","b",0);
    const current=updateNode(updateNode(applied,"a",{title:"new draft"}),"c",{body:"new note"});
    const result=rollbackTreeMutation(before,applied,current)!;
    expect(result.nodes.a.parentId).toBe("r");
    expect(result.nodes.a.title).toBe("new draft"); expect(result.nodes.c.body).toBe("new note");
    expect(before.nodes.a.title).toBe("a"); expect(current.nodes.a.parentId).toBe("b");
  });
  it("restores deleted nodes without overwriting unrelated later edits", () => {
    const before=tree(), applied=removeNode(before,"a"), current=updateNode(applied,"c",{title:"later"});
    const result=rollbackTreeMutation(before,applied,current)!;
    expect(result.nodes.r.childIds).toEqual(["a","b","c"]); expect(result.nodes.c.title).toBe("later");
  });
  it("defers conflicting topology to an authoritative reread", () => {
    const before=tree(), applied=moveNode(before,"a","b",0), current=moveNode(applied,"a","c",0);
    expect(rollbackTreeMutation(before,applied,current)).toBeNull();
    expect(current.nodes.a.parentId).toBe("c");
  });
  it("never restores an old workspace over a different workspace", () => {
    const before=tree(), applied=removeNode(before,"a");
    expect(rollbackTreeMutation(before,applied,{...tree(),rootId:"another"})).toBeNull();
    expect(rollbackTreeMutation(before,applied,null)).toBeNull();
  });
});
describe("clipboard ownership", () => {
  it("uses explicit node mode even when a blurred native selection is stale", () => {
    expect(shouldCopyNodes(3,true,false)).toBe(true);
  });
  it("preserves native copy in editors and outside outline mode", () => {
    expect(shouldCopyNodes(3,true,true)).toBe(false);
    expect(shouldCopyNodes(3,false,false)).toBe(false);
    expect(shouldCopyNodes(1,true,false)).toBe(false);
    expect(shouldCopyNodes(3,true,false,true)).toBe(false);
  });
});
