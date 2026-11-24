/** Type-only Electron bridge declarations shared by the desktop shell and browser provider. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Main-issued identity of one guest reservation. */
export type DesktopBrowserLeaseId = Branded<'DesktopBrowserLeaseId'>

/** A guest's approved, process-local storage partition. */
export interface DesktopBrowserReservation {
  readonly lease: DesktopBrowserLeaseId
  readonly partition: string
}

/** Main-approved request to open an HTTP(S) page from an existing guest. */
export interface DesktopBrowserOpenRequest {
  readonly lease: DesktopBrowserLeaseId
  readonly url: string
}

/** Origin-scoped operations; no Electron objects or arbitrary IPC cross this interface. */
export interface DesktopBrowserBridge {
  /** @param workspace - resolved storage account. @returns one approved guest reservation. */
  acquire(workspace: string): Promise<DesktopBrowserReservation>
  /** @param lease - the caller's reservation. @returns after its guest has been destroyed. */
  release(lease: DesktopBrowserLeaseId): Promise<void>
  /** @param lease - originating guest. @param listener - approved URL consumer. @returns unsubscribe callback. */
  onOpenRequested(lease: DesktopBrowserLeaseId, listener: (url: string) => void): () => void
}

/** One filtered CDP event forwarded from a guest to the owning renderer. */
export interface DesktopBrowserCdpEvent {
  readonly lease: DesktopBrowserLeaseId
  readonly method: string
  readonly params: Record<string, unknown>
}

/**
 * Minimal allowlisted CDP bridge for one Sidebar guest (Route C spike, fork-only).
 * The main process validates every method and parameter against an allowlist
 * and forwards only filtered events; no raw CDP stream ever reaches the renderer.
 */
export interface DesktopBrowserCdpBridge {
  /**
   * @returns the guest lease ids this window owns, in acquire order.
   * The workbench uses the first (only) lease in the PoC; a multi-tab
   * caller would select by URL.
   */
  listLeases(): Promise<DesktopBrowserLeaseId[]>
  /** @param lease - the caller's reservation. Attaches the debugger and enables Page/Network/Runtime. */
  attach(lease: DesktopBrowserLeaseId): Promise<void>
  /** @param lease - the caller's reservation. Detaches the debugger; idempotent. */
  detach(lease: DesktopBrowserLeaseId): Promise<void>
  /**
   * @param lease - the caller's reservation. @param method - allowlisted CDP method.
   * @param params - command parameters, validated in the main process.
   * @returns the command result. Read-only by default; write commands need the spike flag.
   */
  sendAllowedCommand(lease: DesktopBrowserLeaseId, method: string, params?: Record<string, unknown>): Promise<unknown>
  /**
   * @param lease - the caller's reservation. @param events - allowlisted CDP event methods.
   * @param listener - filtered event consumer. @returns unsubscribe callback.
   */
  subscribeFilteredEvent(
    lease: DesktopBrowserLeaseId,
    events: readonly string[],
    listener: (event: DesktopBrowserCdpEvent) => void,
  ): () => void
}
