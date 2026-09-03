import ipaddr from "ipaddr.js";

/**
 * "Soft" IP enforcement — verifies the request came from an address on the
 * organization's allow-list. This is office-network verification, NOT a
 * biometric-grade security control: it can be bypassed by VPNs, proxies, or
 * network spoofing. Callers should surface this limitation to users.
 */

/** Parse a JSON allow-list column into a plain string array (NULL/empty → []). */
export function parseAllowedIps(row) {
  const value = row?.allowed_ip_addresses;
  if (value == null) return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Validate an entry: exact IP, CIDR range, or IPv4 wildcard (192.168.1.*). */
export function isValidIpRule(rule) {
  const value = String(rule).trim();
  if (!value) return false;
  try {
    if (value.includes("/")) {
      const [range, bits] = value.split("/");
      const bitsNum = Number(bits);
      if (isNaN(bitsNum) || bitsNum < 0 || bitsNum > 128) return false;
      if (range.includes(":") || /[a-fA-F]/.test(range)) {
        ipaddr.IPv6.parseCIDR(`${range}/${bitsNum}`);
        return true;
      }
      ipaddr.IPv4.parseCIDR(`${range}/${bitsNum}`);
      return true;
    }
    if (value.endsWith("*")) {
      const prefix = value.slice(0, -1).replace(/\.$/, "");
      const parts = prefix.split(".").filter(Boolean);
      if (parts.length === 0 || parts.length > 4) return false;
      const padded = Array.from({ length: 4 - parts.length }, () => "0").join(".");
      ipaddr.IPv4.parse(parts.length === 4 ? parts.join(".") : `${prefix}.${padded}`);
      return true;
    }
    ipaddr.parse(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Does `requestIp` match any rule in `allowedList`?
 * Supports exact IPs, IPv4/IPv6 CIDR ranges, and IPv4 wildcards.
 */
export function ipMatches(requestIp, allowedList) {
  if (!requestIp) return false;

  let ip;
  try {
    ip = ipaddr.process(String(requestIp));
  } catch {
    return false;
  }
  const list = Array.isArray(allowedList) ? allowedList : [];

  for (const raw of list) {
    const rule = String(raw).trim();
    if (!rule) continue;
    try {
      if (rule.includes("/")) {
        const [range, bits] = rule.split("/");
        if (range.includes(":") || /[a-fA-F]/.test(range)) {
          if (ip.kind() !== "ipv6") continue;
          const [cidr] = ipaddr.IPv6.parseCIDR(`${range}/${bits}`);
          if (ip.match([cidr, Number(bits)])) return true;
        } else {
          if (ip.kind() !== "ipv4") continue;
          const [cidr] = ipaddr.IPv4.parseCIDR(`${range}/${bits}`);
          if (ip.match([cidr, Number(bits)])) return true;
        }
        continue;
      }
      if (rule.endsWith("*")) {
        const prefix = rule.slice(0, -1);
        if (ip.kind() === "ipv4" && ip.toString().startsWith(prefix)) return true;
        continue;
      }
      const parsed = ipaddr.parse(rule);
      if (parsed.kind() === ip.kind() && ip.toString() === parsed.toString()) return true;
    } catch {
      // skip malformed rules
    }
  }
  return false;
}