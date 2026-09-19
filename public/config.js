/**
 * 云服务公开配置
 *
 * 这两个值直接来自 WorkBuddy 云服务激活时返回的 publicConfig，
 * 是唯一允许出现在前端源码中的云服务标识。
 * publishableKey 只标识"是哪个应用"，本身不含任何权限，
 * 真正的权限由服务端的精确 Origin 校验 + 登录会话决定。
 *
 * 不要修改这两个值；不要在这里放任何长期密钥。
 */
window.APP_CONFIG = {
  endpoint: 'https://info-vault.app.workbuddy.host',
  publishableKey: 'wbpk_nYUBg7YCbzNbEX9V2pDJ4d_MK7MSJ4Y7RrTE1T8gAdIPFCuFVbjUF8t'
}
