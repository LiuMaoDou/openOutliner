import { useEffect, useRef } from "react"

const IDLE_TIMEOUT_MS = 10_000
const PRIVACY_LOCK_EVENT = "outliner-privacy-lock"
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "input", "wheel", "scroll", "touchmove"] as const

export function activatePrivacyScreen() {
  window.dispatchEvent(new Event(PRIVACY_LOCK_EVENT))
}

export function PrivacyScreen() {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current!
    let deadline = Date.now() + IDLE_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout>
    let selection: {
      input: HTMLInputElement | HTMLTextAreaElement
      start: number
      end: number
      direction: "forward" | "backward" | "none"
    } | null = null

    const lock = () => {
      clearTimeout(timer)
      if (dialog.open) return
      const active = document.activeElement
      selection = (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
        && active.selectionStart !== null && active.selectionEnd !== null
        ? { input: active, start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection ?? "none" }
        : null
      // A modal dialog also makes portaled menus and the editor inert.
      dialog.showModal()
    }

    const checkDeadline = () => {
      clearTimeout(timer)
      if (dialog.open) return
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        lock()
      } else {
        timer = setTimeout(checkDeadline, remaining)
      }
    }

    const recordActivity = (event: Event) => {
      if (dialog.open) return
      // A throttled background timer must not be bypassed by the first click back.
      if (Date.now() >= deadline) {
        checkDeadline()
        event.stopImmediatePropagation()
        if (event.cancelable) event.preventDefault()
        return
      }
      deadline = Date.now() + IDLE_TIMEOUT_MS
      checkDeadline()
    }

    const unlock = (event: Event) => {
      event.stopPropagation()
      // Reset before close restores focus to the previous editor/control.
      deadline = Date.now() + IDLE_TIMEOUT_MS
      dialog.close()
      if (selection?.input.isConnected) {
        selection.input.focus({ preventScroll: true })
        selection.input.setSelectionRange(selection.start, selection.end, selection.direction)
      }
      selection = null
      checkDeadline()
    }

    const guardKeyboard = (event: KeyboardEvent) => {
      if (!dialog.open) return
      // Stop global outline shortcuts and offer a keyboard equivalent to clicking.
      event.stopImmediatePropagation()
      if (event.key !== "Tab") event.preventDefault()
      if (event.target === dialog && (event.key === "Enter" || event.key === " ")) unlock(event)
    }

    const preventDismiss = (event: Event) => event.preventDefault()
    window.addEventListener("keydown", guardKeyboard, true)
    for (const type of ACTIVITY_EVENTS) {
      window.addEventListener(type, recordActivity, { capture: true })
    }
    window.addEventListener("focus", checkDeadline)
    window.addEventListener(PRIVACY_LOCK_EVENT, lock)
    document.addEventListener("visibilitychange", checkDeadline)
    dialog.addEventListener("cancel", preventDismiss)
    dialog.addEventListener("click", unlock)
    checkDeadline()

    return () => {
      clearTimeout(timer)
      window.removeEventListener("keydown", guardKeyboard, true)
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, recordActivity, true)
      window.removeEventListener("focus", checkDeadline)
      window.removeEventListener(PRIVACY_LOCK_EVENT, lock)
      document.removeEventListener("visibilitychange", checkDeadline)
      dialog.removeEventListener("cancel", preventDismiss)
      dialog.removeEventListener("click", unlock)
      dialog.close()
    }
  }, [])

  return (
    <dialog ref={dialogRef} className="privacyScreen" aria-label="点击任意位置恢复使用，也可按回车或空格" tabIndex={0} />
  )
}
