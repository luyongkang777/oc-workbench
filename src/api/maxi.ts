import { localRequest } from './client'

/**
 * 码栖通道：`/local/maxi/*`（外壳与 dev 两套实现，字段逐字一致）。
 *
 * 登录态来自本机码栖客户端（`%APPDATA%\Maxi`），导入后由外壳负责续期；
 * 页面只关心「接没接上、模型叫什么、转发地址和本机密钥是什么」。
 */

export type MaxiStatus = {
  ok: boolean
  /** 已经导入过登录态（可以接） */
  configured: boolean
  /** 本机装了码栖客户端、有可读的登录文件 */
  available: boolean
  host: string
  deviceId: string
  deviceName: string
  model: string
  /** 访问令牌的到期时间（毫秒时间戳），只用来展示 */
  expires: number
  /** 本地转发路径，配合页面 origin 拼成 baseURL */
  path: string
  /** 本地转发密钥（opencode 用它认人） */
  apiKey: string
}

export type MaxiImportResult = {
  ok: boolean
  error?: string
  model?: string
  status?: MaxiStatus
}

export function getMaxiStatus(): Promise<MaxiStatus> {
  return localRequest<MaxiStatus>('/local/maxi/status')
}

/** 从本机码栖客户端读登录态（微信小程序绑定过就行）。 */
export function importMaxi(): Promise<MaxiImportResult> {
  return localRequest<MaxiImportResult>('/local/maxi/import', undefined, 40_000, {
    method: 'POST',
  })
}

export function logoutMaxi(): Promise<MaxiStatus> {
  return localRequest<MaxiStatus>('/local/maxi/logout', undefined, 20_000, {
    method: 'POST',
  })
}

/** 扫码绑定：建二维码（返回 SVG data URL）。 */
export type MaxiBindTicket = {
  ok: boolean
  ticket?: string
  pollKey?: string
  qr?: string
  expiresInSeconds?: number
  error?: string
}

/** 扫码绑定：轮询结果。 */
export type MaxiBindPoll = {
  ok: boolean
  status?: 'pending' | 'confirmed' | 'expired' | string
  configured?: boolean
  deviceName?: string
  username?: string
  model?: string
  error?: string
}

export function bindCreate(): Promise<MaxiBindTicket> {
  return localRequest<MaxiBindTicket>('/local/maxi/bind/create', undefined, 30_000, {
    method: 'POST',
  })
}

export function bindPoll(ticket: string, pollKey: string): Promise<MaxiBindPoll> {
  const query = new URLSearchParams({ ticket, pollKey }).toString()
  return localRequest<MaxiBindPoll>('/local/maxi/bind/poll?' + query, undefined, 25_000)
}
