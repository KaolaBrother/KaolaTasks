const LOGINABLE_PROVIDERS = new Set(['local', 'gitlab', 'gitea'])

export function isLoginableAdmin(user: {
  status: string
  permissionLevel: string
  provider: string
}): boolean {
  return (
    user.status === 'active' &&
    user.permissionLevel === 'admin' &&
    LOGINABLE_PROVIDERS.has(user.provider)
  )
}

export function canPublish(user: { status: string; permissionLevel: string }): boolean {
  return user.status === 'active' && (user.permissionLevel === 'admin' || user.permissionLevel === 'full')
}

export function canManageInstance(user: { status: string; permissionLevel: string }): boolean {
  return user.status === 'active' && user.permissionLevel === 'admin'
}
