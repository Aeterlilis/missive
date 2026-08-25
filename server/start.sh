#!/usr/bin/env bash
# 启动脚本：自动定位系统 CA 证书包，解决 Node 报 "unable to get local issuer certificate" 的问题。
# （Node 默认不读系统证书库；在部分环境里 HTTPS 全部因此失败。）
# 然后启动 Missive 后端。
#
# 用法：  ./start.sh     或   npm start

set -e
cd "$(dirname "$0")"

# 找一个存在的系统 CA 包，第一个命中的就用
for ca in \
  "/etc/ssl/cert.pem" \
  "/etc/pki/tls/certs/ca-bundle.crt" \
  "/etc/ssl/certs/ca-bundle.crt" \
  "/usr/local/share/ca-certificates" \
  "/usr/local/etc/openssl@3/cert.pem" \
  "/opt/homebrew/etc/openssl@3/cert.pem"; do
  if [ -f "$ca" ]; then
    export NODE_EXTRA_CA_CERTS="$ca"
    break
  fi
done

# 若还没找到，且系统有 security 工具（macOS），尝试从 Keychain 导出
if [ -z "$NODE_EXTRA_CA_CERTS" ] && command -v security >/dev/null 2>&1; then
  TMP_CA="$(mktemp -t missive-cacert)"
  if security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain >"$TMP_CA" 2>/dev/null && [ -s "$TMP_CA" ]; then
    export NODE_EXTRA_CA_CERTS="$TMP_CA"
  else
    rm -f "$TMP_CA"
  fi
fi

if [ -n "$NODE_EXTRA_CA_CERTS" ]; then
  echo "使用 CA 证书包: $NODE_EXTRA_CA_CERTS"
else
  echo "（未找到系统 CA 包，直接启动；若 HTTPS 报证书错误请手动设置 NODE_EXTRA_CA_CERTS）"
fi

exec node index.js
