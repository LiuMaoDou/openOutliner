/** Node selection owns Copy only while no editor owns keyboard focus.
 * A blurred textarea can leave window.getSelection().toString() nonempty.
 */
export function shouldCopyNodes(selectedCount: number, keyboardActive: boolean, editable: boolean, prevented = false): boolean {
  return selectedCount > 1 && keyboardActive && !editable && !prevented;
}

export function clearTitleNativeSelection(input: HTMLTextAreaElement): void {
  input.setSelectionRange(input.selectionEnd, input.selectionEnd);
  input.ownerDocument.defaultView?.getSelection()?.removeAllRanges();
}
