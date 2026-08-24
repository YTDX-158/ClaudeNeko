// routes/remote.js — 远程访问开关与状态（设置页用）
import { sendJson } from '../lib/util.js';

export function remoteHandler({ pairing, remote }) {
  return async (req, res, url) => {
    const { pathname } = url;
    const method = req.method;

    // 当前远程状态 + 配对码（开启时才返回码，关着不暴露）
    if (method === 'GET' && pathname === '/api/remote/status') {
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
      return sendJson(res, 200, { enabled, publicUrl: enabled ? urlInfo.url : null, pairCode: code });
    }

    // 关闭远程：停隧道 + 关代理 + 删配对码文件
    if (method === 'POST' && pathname === '/api/remote/off') {
      remote.stop();
      pairing.clearPairCode();
      return sendJson(res, 200, { enabled: false });
    }

    // 重新生成配对码（不改开关状态）
    if (method === 'POST' && pathname === '/api/remote/regenerate-code') {
      const code = pairing.generatePairCode();
      return sendJson(res, 200, { pairCode: code });
    }

    return null;
  };
}
