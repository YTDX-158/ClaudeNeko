// routes/remote.js — 远程访问开关与状态（设置页用）
import { sendJson } from '../lib/util.js';

export function remoteHandler({ pairing, remote }) {
  return async (req, res, url) => {
    const { pathname } = url;
    const method = req.method;

    // 当前远程状态 + 配对码（开启时才返回码，关着不暴露）
    if (method === 'GET' && pathname === '/api/remote/status') {
      // 配对码是远程访问唯一密钥，本机 GET 也无鉴权 → 校验来源，防恶意网页 DNS rebinding 读到码
      const origin = req.headers.origin || req.headers.referer || '';
      // 无来源头=同源/本地程序放行；Origin: null（沙箱 iframe/data:）一律视为陌生来源
      const isLocal = !origin || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(origin);
      if (!isLocal) return sendJson(res, 403, { error: '来源校验失败' });
      const enabled = remote.isEnabled();
      return sendJson(res, 200, {
        enabled,
        publicUrl: enabled ? remote.publicUrl() : null,
        pairCode: enabled ? pairing.readPairCode() : null,
      });
    }

    // 开启远程：起代理 + 起隧道。幂等——已开启则保持原配对码（不换码，避免已配对设备失效）
    if (method === 'POST' && pathname === '/api/remote/on') {
      if (remote.isEnabled()) {
        return sendJson(res, 200, {
          enabled: true,
          publicUrl: remote.publicUrl(),
          pairCode: pairing.readPairCode(),
        });
      }
      const code = pairing.generatePairCode();
      const urlInfo = await remote.start();
      // 用 isEnabled() 判断真实状态：代理启动失败（如端口被占）时是 false，不误报"已开启"
      const enabled = remote.isEnabled();
      // 失败时把真实原因带给前端（之前笼统提示"可能 cloudflared 未装"误导排查：9-02 QQ占4001实锤）
      return sendJson(res, 200, {
        enabled,
        publicUrl: enabled ? urlInfo.url : null,
        error: enabled ? null : (urlInfo.error || '远程代理启动失败'),
        pairCode: code,
      });
    }

    // 关闭远程：停隧道 + 关代理 + 删配对码 + 清空已配对设备（关闭=全部重置）
    if (method === 'POST' && pathname === '/api/remote/off') {
      remote.stop();
      pairing.clearPairCode();
      pairing.clearSessions();
      return sendJson(res, 200, { enabled: false });
    }

    // 重新生成配对码 + 清空已配对设备（换码 = 旧设备全部失效，需重新配对，防设备丢失残留）
    if (method === 'POST' && pathname === '/api/remote/regenerate-code') {
      const code = pairing.generatePairCode();
      pairing.clearSessions();
      return sendJson(res, 200, { pairCode: code });
    }

    return null;
  };
}
