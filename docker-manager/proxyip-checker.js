/**
 * ProxyIP 检测服务
 * 参考 CF-Workers-CheckProxyIP 的检测原理
 */

const http = require('http');
const tls = require('tls');

const PROBE_TARGETS = [
    { name: 'ipv4', host: 'ipv4.090227.xyz' },
    { name: 'ipv6', host: 'ipv6.090227.xyz' }
];
const PROBE_TIMEOUT = 9999;
const MAX_RESPONSE_SIZE = 65536;

// 地区映射表
const REGION_MAP = {
    'HK': ['HK', '香港', 'Hong Kong', 'hongkong'],
    'TW': ['TW', '台湾', 'Taiwan'],
    'JP': ['JP', '日本', 'Japan', 'Tokyo'],
    'SG': ['SG', '新加坡', 'Singapore'],
    'US': ['US', '美国', 'United States', 'America'],
    'KR': ['KR', '韩国', 'Korea', 'Seoul'],
    'DE': ['DE', '德国', 'Germany'],
    'UK': ['GB', 'UK', '英国', 'United Kingdom', 'London'],
    'FR': ['FR', '法国', 'France', 'Paris'],
    'NL': ['NL', '荷兰', 'Netherlands', 'Amsterdam']
};

/**
 * 检测 ProxyIP 的有效性
 * @param {string} proxyIP - IP地址
 * @param {number} port - 端口号
 * @returns {Promise<Object>} 检测结果
 */
async function checkProxyIP(proxyIP, port = 443) {
    const startTime = Date.now();
    
    try {
        // 上游使用真实 TLS SNI 和出口探针验证反代，而不是检查 /cdn-cgi/trace 文本。
        const probeResults = await Promise.all(
            PROBE_TARGETS.map(target => testProbe(proxyIP, port, target))
        );
        const successfulProbe = probeResults.find(result => result.success);
        const responseTime = Date.now() - startTime;

        if (successfulProbe) {
            // 获取IP地理位置信息
            const geoInfo = await getIPInfo(proxyIP);
            
            return {
                success: true,
                status: 'active',
                responseTime,
                region: geoInfo.region,
                country: geoInfo.country,
                isp: geoInfo.isp,
                city: geoInfo.city,
                latitude: geoInfo.latitude,
                longitude: geoInfo.longitude
            };
        } else {
            return {
                success: false,
                status: 'failed',
                responseTime,
                error: probeResults.map(result => result.error).filter(Boolean).join('; ') || '代理测试失败'
            };
        }
        
    } catch (error) {
        return {
            success: false,
            status: 'failed',
            responseTime: -1,
            error: error.message || '检测异常'
        };
    }
}

/**
 * 使用上游相同的双探针检测：TLS SNI 必须是探针域名，返回必须是带出口 IP 的 JSON。
 */
function testProbe(proxyIP, port, target) {
    return new Promise((resolve) => {
        const hostname = String(proxyIP).replace(/^\[|\]$/g, '');
        const socket = tls.connect({
            host: hostname,
            port,
            servername: target.host,
            rejectUnauthorized: false,
            timeout: PROBE_TIMEOUT
        });
        const chunks = [];
        let totalSize = 0;
        let settled = false;

        const finish = (result) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(result);
        };

        socket.on('secureConnect', () => {
            const certificate = socket.getPeerCertificate();
            const certificateError = tls.checkServerIdentity(target.host, certificate);
            if (certificateError) {
                finish({ success: false, error: `证书主机名不匹配: ${certificateError.message}` });
                return;
            }

            socket.write(
                `GET / HTTP/1.1\r\nHost: ${target.host}\r\n` +
                'Accept: application/json, text/plain, */*\r\n' +
                'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\n' +
                'Accept-Encoding: identity\r\nConnection: close\r\n\r\n'
            );
        });

        socket.on('data', (chunk) => {
            totalSize += chunk.length;
            if (totalSize <= MAX_RESPONSE_SIZE) chunks.push(chunk);
            if (totalSize > MAX_RESPONSE_SIZE) {
                finish({ success: false, error: '响应超过大小限制' });
            }
        });

        socket.on('end', () => {
            if (settled) return;
            try {
                const raw = Buffer.concat(chunks);
                const separator = raw.indexOf('\r\n\r\n');
                const header = (separator < 0 ? raw : raw.subarray(0, separator)).toString('latin1');
                const status = Number((header.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/m) || [])[1]);
                let body = separator < 0 ? Buffer.alloc(0) : raw.subarray(separator + 4);
                if (/\r\ntransfer-encoding:\s*chunked\r\n/i.test(`\r\n${header}\r\n`)) {
                    body = decodeChunkedBody(body);
                }
                if (status !== 200) {
                    finish({ success: false, error: `响应状态异常: ${status || 'unknown'}` });
                    return;
                }
                const payload = JSON.parse(body.toString('utf8'));
                const exitIP = payload && payload.ip || payload && payload.ipAddress;
                if (typeof exitIP !== 'string' || !exitIP) {
                    finish({ success: false, error: '探针响应缺少出口 IP' });
                    return;
                }
                finish({ success: isMatchingFamily(exitIP, target.name), exitIP });
            } catch (error) {
                finish({ success: false, error: error.message });
            }
        });

        socket.on('timeout', () => finish({ success: false, error: '检测超时' }));
        socket.on('error', (error) => finish({ success: false, error: error.message }));
    });
}

function decodeChunkedBody(body) {
    const chunks = [];
    let offset = 0;
    while (offset < body.length) {
        const lineEnd = body.indexOf('\r\n', offset);
        if (lineEnd < 0) throw new Error('分块响应格式错误');
        const size = parseInt(body.subarray(offset, lineEnd).toString('ascii').split(';', 1)[0], 16);
        if (!Number.isFinite(size)) throw new Error('分块大小无效');
        if (size === 0) break;
        const start = lineEnd + 2;
        const end = start + size;
        if (end + 2 > body.length) throw new Error('分块响应不完整');
        chunks.push(body.subarray(start, end));
        offset = end + 2;
    }
    return Buffer.concat(chunks);
}

function isMatchingFamily(ip, family) {
    if (family === 'ipv4') return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split('.').every(part => Number(part) <= 255);
    return ip.includes(':');
}

/**
 * 获取IP地理位置信息
 */
async function getIPInfo(ip) {
    return new Promise((resolve) => {
        const options = {
            hostname: 'ip-api.com',
            port: 80,
            path: `/json/${ip}?lang=zh-CN&fields=status,country,countryCode,region,regionName,city,lat,lon,isp,org`,
            method: 'GET',
            timeout: 5000
        };
        
        const req = http.request(options, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                try {
                    const info = JSON.parse(data);
                    
                    if (info.status === 'success') {
                        // 识别地区代码
                        const region = detectRegion(info.countryCode, info.city, info.regionName);
                        
                        resolve({
                            country: info.country || info.countryCode,
                            region: region,
                            city: info.city,
                            isp: info.isp || info.org,
                            latitude: info.lat,
                            longitude: info.lon
                        });
                    } else {
                        resolve(getDefaultGeoInfo());
                    }
                } catch (e) {
                    resolve(getDefaultGeoInfo());
                }
            });
        });
        
        req.on('error', () => {
            resolve(getDefaultGeoInfo());
        });
        
        req.on('timeout', () => {
            req.destroy();
            resolve(getDefaultGeoInfo());
        });
        
        req.end();
    });
}

/**
 * 识别地区
 */
function detectRegion(countryCode, city = '', regionName = '') {
    const searchText = `${countryCode} ${city} ${regionName}`.toLowerCase();
    
    for (const [region, keywords] of Object.entries(REGION_MAP)) {
        for (const keyword of keywords) {
            if (searchText.includes(keyword.toLowerCase())) {
                return region;
            }
        }
    }
    
    return countryCode || 'UNKNOWN';
}

/**
 * 默认地理信息
 */
function getDefaultGeoInfo() {
    return {
        country: null,
        region: null,
        city: null,
        isp: null,
        latitude: null,
        longitude: null
    };
}

/**
 * 批量检测 ProxyIP
 */
async function batchCheckProxyIPs(proxyList, concurrency = 3) {
    const results = [];
    
    for (let i = 0; i < proxyList.length; i += concurrency) {
        const batch = proxyList.slice(i, i + concurrency);
        const batchResults = await Promise.all(
            batch.map(proxy => checkProxyIP(proxy.address, proxy.port))
        );
        
        results.push(...batchResults.map((result, index) => ({
            ...proxyList[i + index],
            ...result
        })));
    }
    
    return results;
}

module.exports = {
    checkProxyIP,
    batchCheckProxyIPs,
    getIPInfo,
    detectRegion
};
