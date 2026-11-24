/** Minimal allowlisted CDP bridge for one Sidebar browser guest (Route C spike). */
import type { WebContents } from 'electron'
import type { DesktopBrowserLeaseId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { DesktopBrowserGuests } from './browser-guests.ts'

/** CDP protocol version the bridge attaches with. */
const CDP_PROTOCOL_VERSION = '1.3'

/**
 * CDP commands the bridge may send. Read-only by default; `Runtime.evaluate`
 * is further restricted to single-expression pure reads (see
 * `assertReadOnlyEvaluate`). No navigation, no script injection, no storage
 * access, no cookie access.
 */
const READ_COMMANDS = new Set([
  'Page.enable',
  'Page.disable',
  'Page.captureScreenshot',
  'Page.getLayoutMetrics',
  'Runtime.enable',
  'Runtime.disable',
  'Runtime.evaluate',
  'Network.enable',
  'Network.disable',
])

/**
 * Write commands. Only usable when the bridge is created with
 * `allowWriteCommands: true`. Spike-only: the Agent-click check (check 5)
 * needs `Input.dispatchMouseEvent`; remove the flag before any production use.
 */
const WRITE_COMMANDS = new Set(['Input.dispatchMouseEvent'])

/** CDP events the bridge may forward, after filtering in this module. */
const EVENT_ALLOWLIST = new Set([
  'Network.requestWillBeSent',
  'Network.responseReceived',
  'Network.loadingFinished',
  'Network.loadingFailed',
  'Page.loadEventFired',
  'Page.frameNavigated',
  'Runtime.consoleAPICalled',
])

/** One filtered CDP event, ready to forward to the owning renderer. */
export interface CdpBridgeEvent {
  readonly lease: DesktopBrowserLeaseId
  readonly method: string
  readonly params: Record<string, unknown>
}

/** Options for `DesktopBrowserCdpBridge`. */
export interface CdpBridgeOptions {
  /**
   * Allow write commands (`Input.dispatchMouseEvent`). Default false.
   * Spike-only; the Agent-click check needs it. Never enable in production.
   */
  allowWriteCommands?: boolean
  /**
   * Called for each allowlisted CDP event, already filtered. The caller
   * (main.ts) forwards it to the owning renderer via `owner.send`.
   */
  emit: (owner: WebContents, event: CdpBridgeEvent) => void
}

/** Per-lease debugger state held by the bridge. */
interface AttachedGuest {
  readonly owner: WebContents
  readonly guest: WebContents
  /** Events this lease subscribed to; empty means no forwarding. */
  readonly events: Set<string>
  /** Bound `debugger` message handler, so detach can remove it. */
  readonly onMessage: (event: Electron.Event, method: string, params: unknown) => void
  /** Bound `debugger` detach handler, so detach can remove it. */
  readonly onDebuggerDetach: (event: Electron.Event, reason: string) => void
  /** Bound guest-destroyed handler, so detach can remove it. */
  readonly onGuestDestroyed: () => void
}

/**
 * Main-process CDP bridge keyed by `guestLeaseId`. One guest holds at most
 * one debugger client; the bridge refuses to attach when another debugger
 * (e.g. guest DevTools in a dev build) already owns the target.
 *
 * Security invariants:
 * - Only the lease owner (main-window top frame, enforced by the IPC
 *   `assertProductSender` check in main.ts plus `guestFor` ownership) may
 *   attach, send, or subscribe.
 * - Only allowlisted commands run; anything else is rejected before it
 *   reaches the debugger. `Runtime.evaluate` is restricted to
 *   single-expression pure reads.
 * - Only allowlisted events are forwarded, with headers/bodies stripped.
 * - No CDP endpoint is ever exposed: the debugger is attached in-process
 *   via `webContents.debugger`, never via a remote-debugging port.
 */
export class DesktopBrowserCdpBridge {
  private readonly guests: DesktopBrowserGuests
  private readonly allowWriteCommands: boolean
  private readonly emit: CdpBridgeOptions['emit']
  private readonly attached = new Map<DesktopBrowserLeaseId, AttachedGuest>()

  constructor(guests: DesktopBrowserGuests, options: CdpBridgeOptions) {
    this.guests = guests
    this.allowWriteCommands = options.allowWriteCommands ?? false
    this.emit = options.emit
  }

  /** True when this bridge currently owns the debugger for the lease. */
  isAttached(lease: DesktopBrowserLeaseId): boolean {
    return this.attached.has(lease)
  }

  /**
   * List the guest lease ids the caller owns (see
   * `DesktopBrowserGuests.leasesFor`). The workbench calls this before
   * `attach` because the lease is private to the Sidebar guest; a caller
   * only ever learns its own leases.
   * @param owner - authenticated IPC sender.
   * @returns the lease ids owned by this window, in acquire order.
   */
  listLeases(owner: WebContents): DesktopBrowserLeaseId[] {
    return this.guests.leasesFor(owner)
  }

  /**
   * Attach the debugger to the guest for a lease and enable the domains
   * the event allowlist needs (Page, Network, Runtime).
   * @param owner - authenticated IPC sender; must own the lease.
   * @param lease - guest lease received over IPC.
   * @throws when the lease is unknown, owned by another window, the guest
   * is not yet bound, or another debugger already owns the target.
   */
  async attach(owner: WebContents, lease: unknown): Promise<void> {
    const id = assertLeaseId(lease)
    if (this.attached.has(id)) return
    const guest = this.guests.guestFor(owner, id)
    if (guest === undefined) {
      throw new Error('desktop browser cdp: guest not yet bound for this lease; retry after the tab loads')
    }
    if (guest.isDestroyed()) throw new Error('desktop browser cdp: guest is destroyed')
    if (guest.debugger.isAttached()) {
      throw new Error('desktop browser cdp: another debugger already owns this guest (close guest DevTools first)')
    }
    const onMessage = (_event: Electron.Event, method: string, params: unknown): void => {
      this.forwardEvent(id, method, params)
    }
    const onDebuggerDetach = (_event: Electron.Event, reason: string): void => {
      // The debugger went away without our detach (e.g. DevTools took over
      // or the target crashed): drop our state so a later attach is clean.
      this.attached.delete(id)
      console.error(`desktop browser cdp: debugger detached for ${id}: ${reason}`)
    }
    const onGuestDestroyed = (): void => {
      this.attached.delete(id)
    }
    guest.debugger.on('message', onMessage)
    guest.debugger.on('detach', onDebuggerDetach)
    guest.once('destroyed', onGuestDestroyed)
    try {
      guest.debugger.attach(CDP_PROTOCOL_VERSION)
      await guest.debugger.sendCommand('Page.enable')
      await guest.debugger.sendCommand('Network.enable')
      await guest.debugger.sendCommand('Runtime.enable')
    } catch (error) {
      guest.debugger.off('message', onMessage)
      guest.debugger.off('detach', onDebuggerDetach)
      guest.off('destroyed', onGuestDestroyed)
      if (guest.debugger.isAttached()) {
        try { guest.debugger.detach() } catch { /* already detached */ }
      }
      throw error
    }
    this.attached.set(id, { owner, guest, events: new Set(), onMessage, onDebuggerDetach, onGuestDestroyed })
  }

  /**
   * Detach the debugger for a lease. Idempotent: detaching a lease that
   * was never attached (or already detached) is a no-op.
   */
  detach(owner: WebContents, lease: unknown): void {
    const id = assertLeaseId(lease)
    const entry = this.attached.get(id)
    if (entry === undefined) return
    if (entry.owner !== owner) throw new Error('desktop browser cdp: guest belongs to another window')
    this.attached.delete(id)
    entry.guest.off('destroyed', entry.onGuestDestroyed)
    const { guest } = entry
    guest.debugger.off('message', entry.onMessage)
    guest.debugger.off('detach', entry.onDebuggerDetach)
    if (!guest.isDestroyed() && guest.debugger.isAttached()) {
      try { guest.debugger.detach() } catch { /* already detached */ }
    }
  }

  /**
   * Send one allowlisted CDP command to the guest. The lease must be
   * attached first (call `attach`).
   * @returns the command result as returned by the debugger.
   * @throws when the lease is not attached, the command is not allowlisted,
   * or the parameters fail validation.
   */
  async sendAllowedCommand(
    owner: WebContents,
    lease: unknown,
    method: unknown,
    params: unknown,
  ): Promise<unknown> {
    const id = assertLeaseId(lease)
    if (typeof method !== 'string' || method.length === 0) {
      throw new Error('desktop browser cdp: a CDP method name is required')
    }
    const entry = this.attached.get(id)
    if (entry === undefined) throw new Error('desktop browser cdp: lease is not attached; call attach first')
    if (entry.owner !== owner) throw new Error('desktop browser cdp: guest belongs to another window')
    const { guest } = entry
    if (guest.isDestroyed()) throw new Error('desktop browser cdp: guest is destroyed')
    const args = assertCommandParams(method, params, this.allowWriteCommands)
    return guest.debugger.sendCommand(method, args)
  }

  /**
   * Subscribe a lease to a filtered set of CDP events. The lease must be
   * attached first. Re-subscribing replaces the previous event set.
   * @param events - CDP event method names; every one must be allowlisted.
   */
  subscribe(owner: WebContents, lease: unknown, events: unknown): void {
    const id = assertLeaseId(lease)
    const entry = this.attached.get(id)
    if (entry === undefined) throw new Error('desktop browser cdp: lease is not attached; call attach first')
    if (entry.owner !== owner) throw new Error('desktop browser cdp: guest belongs to another window')
    if (!Array.isArray(events) || events.length === 0) {
      throw new Error('desktop browser cdp: at least one event method is required')
    }
    const next = new Set<string>()
    for (const event of events) {
      if (typeof event !== 'string' || !EVENT_ALLOWLIST.has(event)) {
        throw new Error(`desktop browser cdp: event not allowlisted: ${String(event)}`)
      }
      next.add(event)
    }
    entry.events.clear()
    for (const event of next) entry.events.add(event)
  }

  /**
   * Stop forwarding events for a lease. Idempotent. The debugger stays
   * attached; call `detach` to release it.
   */
  unsubscribe(owner: WebContents, lease: unknown): void {
    const id = assertLeaseId(lease)
    const entry = this.attached.get(id)
    if (entry === undefined) return
    if (entry.owner !== owner) throw new Error('desktop browser cdp: guest belongs to another window')
    entry.events.clear()
  }

  /**
   * Forward one debugger message when it is allowlisted and subscribed.
   * Strips everything the recorder must never see (headers, bodies,
   * console arguments) before emitting.
   */
  private forwardEvent(lease: DesktopBrowserLeaseId, method: string, params: unknown): void {
    const entry = this.attached.get(lease)
    if (entry === undefined || !entry.events.has(method) || !EVENT_ALLOWLIST.has(method)) return
    if (entry.owner.isDestroyed()) return
    const filtered = filterEventParams(method, params)
    if (filtered === undefined) return
    this.emit(entry.owner, { lease, method, params: filtered })
  }
}

/** Validate a lease id received over IPC; returns the branded id. */
function assertLeaseId(lease: unknown): DesktopBrowserLeaseId {
  if (typeof lease !== 'string' || lease.length === 0) {
    throw new Error('desktop browser cdp: a guest lease id is required')
  }
  return lease as DesktopBrowserLeaseId
}

/**
 * Validate a CDP command name and parameters against the allowlist.
 * @returns the parameters object to pass to `sendCommand`.
 */
function assertCommandParams(
  method: string,
  params: unknown,
  allowWriteCommands: boolean,
): Record<string, unknown> {
  const isRead = READ_COMMANDS.has(method)
  const isWrite = WRITE_COMMANDS.has(method)
  if (!isRead && !isWrite) {
    throw new Error(`desktop browser cdp: command not allowlisted: ${method}`)
  }
  if (isWrite && !allowWriteCommands) {
    throw new Error(`desktop browser cdp: write command not enabled for this build: ${method}`)
  }
  if (params === undefined) return {}
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new Error('desktop browser cdp: command params must be an object')
  }
  const args = params as Record<string, unknown>
  switch (method) {
    case 'Runtime.evaluate':
      assertReadOnlyEvaluate(args)
      return args
    case 'Page.captureScreenshot':
      assertCaptureScreenshot(args)
      return args
    case 'Input.dispatchMouseEvent':
      assertMouseEvent(args)
      return args
    default:
      return args
  }
}

/**
 * Restrict `Runtime.evaluate` to single-expression pure reads.
 * Spike-grade guard, not a security proof: a production bridge should
 * replace this denylist with an exact-expression allowlist or fixed read
 * operations owned by the bridge. It rejects assignments, statement lists,
 * and the dangerous calls a write would need; the adapter's fixed read
 * scripts are written as single pure expressions so they pass.
 */
function assertReadOnlyEvaluate(args: Record<string, unknown>): void {
  if (args.returnByValue !== true) {
    throw new Error('desktop browser cdp: Runtime.evaluate must use returnByValue: true')
  }
  if (args.awaitPromise === true) {
    throw new Error('desktop browser cdp: Runtime.evaluate must not await a promise')
  }
  const expression = args.expression
  if (typeof expression !== 'string' || expression.length === 0 || expression.length > 4000) {
    throw new Error('desktop browser cdp: Runtime.evaluate needs a short expression string')
  }
  const code = stripStringLiterals(expression)
  const denied = [
    'document.write', 'innerHTML', 'outerHTML', '.click(', '.submit(', '.focus(', '.blur(',
    'fetch(', 'XMLHttpRequest', 'WebSocket', 'eval(', 'Function(', 'localStorage', 'sessionStorage',
    'document.cookie', 'location.assign', 'location.replace', 'location.reload',
    'window.open', 'sendBeacon', 'addEventListener',
    'removeEventListener', 'dispatchEvent', 'setAttribute', 'removeAttribute', 'appendChild',
    'removeChild', 'insertBefore', 'replaceChild', 'setTimeout', 'setInterval', 'import(',
    'require(', 'classList.add', 'classList.remove', 'classList.toggle',
  ]
  for (const token of denied) {
    if (code.includes(token)) {
      throw new Error(`desktop browser cdp: Runtime.evaluate rejects read-only violation: ${token}`)
    }
  }
  // A single expression only: no statement separator.
  if (code.includes(';')) {
    throw new Error('desktop browser cdp: Runtime.evaluate rejects statement lists; use a single expression')
  }
  // Bare assignment (`=` not part of `==`, `===`, `=>`, `<=`, `>=`, `!=`).
  if (/(?<![=!<>])=(?![=>])/.test(code)) {
    throw new Error('desktop browser cdp: Runtime.evaluate rejects assignment; use a pure read expression')
  }
}

/** `Page.captureScreenshot`: only still-image formats, no animation. */
function assertCaptureScreenshot(args: Record<string, unknown>): void {
  if (args.format !== undefined && args.format !== 'png' && args.format !== 'jpeg') {
    throw new Error('desktop browser cdp: captureScreenshot format must be png or jpeg')
  }
  if (args.captureBeyondViewport === true) {
    throw new Error('desktop browser cdp: captureScreenshot must not capture beyond the viewport')
  }
}

/** `Input.dispatchMouseEvent`: left-button press/release/move only, in-viewport. */
function assertMouseEvent(args: Record<string, unknown>): void {
  const type = args.type
  if (type !== 'mousePressed' && type !== 'mouseReleased' && type !== 'mouseMoved') {
    throw new Error('desktop browser cdp: mouse event type must be mousePressed, mouseReleased, or mouseMoved')
  }
  if (typeof args.x !== 'number' || typeof args.y !== 'number' || !Number.isFinite(args.x) || !Number.isFinite(args.y)) {
    throw new Error('desktop browser cdp: mouse event needs finite x/y coordinates')
  }
  if (args.button !== undefined && args.button !== 'left') {
    throw new Error('desktop browser cdp: mouse event button must be left')
  }
  if (args.clickCount !== undefined && args.clickCount !== 1) {
    throw new Error('desktop browser cdp: mouse event clickCount must be 1')
  }
}

/**
 * Remove string literals (single, double, backtick) so the read-only check
 * does not trip on `=` or denied tokens inside a string. Minimal scanner:
 * handles backslash escapes; template placeholders are treated as code.
 */
function stripStringLiterals(expression: string): string {
  let out = ''
  let i = 0
  while (i < expression.length) {
    const ch = expression[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i++
      while (i < expression.length && expression[i] !== quote) {
        if (expression[i] === '\\') i++
        i++
      }
      i++
      out += '""'
    } else {
      out += ch
      i++
    }
  }
  return out
}

/**
 * Filter one CDP event's params down to what the recorder may see.
 * Returns undefined when the event carries nothing usable (dropped).
 */
function filterEventParams(method: string, params: unknown): Record<string, unknown> | undefined {
  if (typeof params !== 'object' || params === null) return undefined
  const p = params as Record<string, unknown>
  switch (method) {
    case 'Network.requestWillBeSent': {
      const request = p.request as Record<string, unknown> | undefined
      if (typeof request !== 'object' || request === null) return undefined
      if (typeof p.requestId !== 'string' || typeof request.url !== 'string' || typeof request.method !== 'string') {
        return undefined
      }
      return {
        requestId: p.requestId,
        url: request.url,
        method: request.method,
        timestamp: typeof p.timestamp === 'number' ? p.timestamp : undefined,
      }
    }
    case 'Network.responseReceived': {
      const response = p.response as Record<string, unknown> | undefined
      if (typeof response !== 'object' || response === null) return undefined
      if (typeof p.requestId !== 'string' || typeof response.url !== 'string' || typeof response.status !== 'number') {
        return undefined
      }
      return {
        requestId: p.requestId,
        url: response.url,
        status: response.status,
        mimeType: typeof response.mimeType === 'string' ? response.mimeType : undefined,
        timestamp: typeof p.timestamp === 'number' ? p.timestamp : undefined,
      }
    }
    case 'Network.loadingFinished':
    case 'Network.loadingFailed': {
      if (typeof p.requestId !== 'string') return undefined
      return {
        requestId: p.requestId,
        timestamp: typeof p.timestamp === 'number' ? p.timestamp : undefined,
        ...(typeof p.errorText === 'string' ? { errorText: p.errorText } : {}),
      }
    }
    case 'Page.loadEventFired': {
      return { timestamp: typeof p.timestamp === 'number' ? p.timestamp : undefined }
    }
    case 'Page.frameNavigated': {
      const frame = p.frame as Record<string, unknown> | undefined
      if (typeof frame !== 'object' || frame === null || typeof frame.url !== 'string') return undefined
      return {
        frameId: typeof frame.id === 'string' ? frame.id : undefined,
        url: frame.url,
      }
    }
    case 'Runtime.consoleAPICalled': {
      if (typeof p.type !== 'string') return undefined
      return { type: p.type }
    }
    default:
      return undefined
  }
}
