/** Allowlisted CDP bridge for one Sidebar guest, plus one main-process event subscription per window. */
import { ipcRenderer } from 'electron'
import type {
  DesktopBrowserCdpBridge,
  DesktopBrowserCdpEvent,
  DesktopBrowserLeaseId,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DESKTOP_IPC } from './ipc.ts'

/** @returns CDP operations that expose neither IPC nor Electron objects. */
export function createDesktopBrowserCdpBridge(): DesktopBrowserCdpBridge {
  const listeners = new Map<DesktopBrowserLeaseId, Set<(event: DesktopBrowserCdpEvent) => void>>()
  ipcRenderer.on(DESKTOP_IPC.browserCdpEvent, (_event, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null || !('lease' in payload) || !('method' in payload)
      || !('params' in payload) || typeof payload.lease !== 'string' || typeof payload.method !== 'string'
      || typeof payload.params !== 'object' || payload.params === null) return
    const callbacks = listeners.get(payload.lease as DesktopBrowserLeaseId)
    if (callbacks === undefined) return
    const event: DesktopBrowserCdpEvent = {
      lease: payload.lease as DesktopBrowserLeaseId,
      method: payload.method,
      params: payload.params as Record<string, unknown>,
    }
    for (const callback of [...callbacks]) {
      try { callback(event) }
      catch (error) { console.error('Desktop browser CDP event handler failed', error) }
    }
  })
  return {
    listLeases: () => ipcRenderer.invoke(DESKTOP_IPC.browserCdpListLeases) as Promise<DesktopBrowserLeaseId[]>,
    attach: lease => ipcRenderer.invoke(DESKTOP_IPC.browserCdpAttach, lease) as Promise<void>,
    detach: lease => ipcRenderer.invoke(DESKTOP_IPC.browserCdpDetach, lease) as Promise<void>,
    sendAllowedCommand: (lease, method, params) =>
      ipcRenderer.invoke(DESKTOP_IPC.browserCdpSendCommand, lease, method, params) as Promise<unknown>,
    subscribeFilteredEvent(lease, events, listener) {
      let callbacks = listeners.get(lease)
      if (callbacks === undefined) { callbacks = new Set(); listeners.set(lease, callbacks) }
      callbacks.add(listener)
      // Register the main-process forward once per lease; the invoke is
      // idempotent (re-subscribing replaces the event set).
      void ipcRenderer.invoke(DESKTOP_IPC.browserCdpSubscribe, lease, events).catch((error: unknown) => {
        console.error('Desktop browser CDP subscribe failed', error)
      })
      return () => {
        callbacks.delete(listener)
        if (callbacks.size === 0 && listeners.get(lease) === callbacks) {
          listeners.delete(lease)
          void ipcRenderer.invoke(DESKTOP_IPC.browserCdpUnsubscribe, lease).catch((error: unknown) => {
            console.error('Desktop browser CDP unsubscribe failed', error)
          })
        }
      }
    },
  }
}
