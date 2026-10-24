
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'

const { lanAddresses } = await import('../lan-server.mjs')

const orig = os.networkInterfaces

function withIfaces(fixture, fn) {
  os.networkInterfaces = () => fixture
  try { return fn() } finally { os.networkInterfaces = orig }
}

const v4 = (address) => ({ address, family: 'IPv4', internal: false })
const lo = () => ({ address: '127.0.0.1', family: 'IPv4', internal: true })

const addrs = (list) => list.map((x) => x.address).sort()

test('混合网卡：只留 WLAN，VMware / vEthernet(WSL) 都排掉', () => {
  const out = withIfaces({
    'WLAN': [v4('192.168.31.10')],
    'vEthernet (WSL (Hyper-V firewall))': [v4('172.23.160.1')],
    'VMware Network Adapter VMnet8': [v4('192.168.137.1')]
  }, () => lanAddresses())
  assert.deepEqual(addrs(out), ['192.168.31.10'])
})

test('全是虚拟网卡：回退原逻辑，一个地址都不许少', () => {
  const out = withIfaces({
    'vEthernet (Default Switch)': [v4('172.20.0.1')],
    'Docker Desktop': [v4('172.21.0.1')]
  }, () => lanAddresses())
  assert.deepEqual(addrs(out), ['172.20.0.1', '172.21.0.1'])
})

test('Tailscale + WLAN：两条都留（叠加网不排）', () => {
  const out = withIfaces({
    'Tailscale': [v4('100.101.102.103')],
    'WLAN': [v4('192.168.31.10')]
  }, () => lanAddresses())
  assert.deepEqual(addrs(out), ['100.101.102.103', '192.168.31.10'])
})

test('只有 Tailscale：保留（用户可能就靠它异地连）', () => {
  const out = withIfaces({ 'Tailscale': [v4('100.101.102.103')] }, () => lanAddresses())
  assert.deepEqual(addrs(out), ['100.101.102.103'])
})

test('中文网卡名「以太网」：当物理网卡保留，不误杀', () => {
  const out = withIfaces({ '以太网': [v4('192.168.1.5')] }, () => lanAddresses())
  assert.deepEqual(addrs(out), ['192.168.1.5'])
})

test('Wi-Fi Direct 虚拟适配器 + WLAN：只留 WLAN', () => {
  const out = withIfaces({
    'Microsoft Wi-Fi Direct Virtual Adapter': [v4('192.168.137.2')],
    'WLAN': [v4('192.168.31.10')]
  }, () => lanAddresses())
  assert.deepEqual(addrs(out), ['192.168.31.10'])
})

test('只有回环（internal）：一个都不给', () => {
  const out = withIfaces({ 'Loopback Pseudo-Interface 1': [lo()] }, () => lanAddresses())
  assert.deepEqual(out, [])
})

test('排序：192.168 优先于 10.x 优先于 172.16-31，其余垫底', () => {
  const out = withIfaces({
    'WLAN': [v4('8.8.4.4'), v4('172.20.5.5')],
    'Ethernet': [v4('10.0.0.9'), v4('192.168.0.2')]
  }, () => lanAddresses())
  assert.deepEqual(out.map((x) => x.address), ['192.168.0.2', '10.0.0.9', '172.20.5.5', '8.8.4.4'])
})

test('非 IPv4 / internal 的记录一律跳过（IPv6、回环）', () => {
  const out = withIfaces({
    'WLAN': [{ address: 'fe80::1', family: 'IPv6', internal: false }, lo(), v4('192.168.31.10')]
  }, () => lanAddresses())
  assert.deepEqual(addrs(out), ['192.168.31.10'])
})

test('返回结构是 { name, address }，name 用的是真实网卡名', () => {
  const out = withIfaces({ 'WLAN': [v4('192.168.31.10')] }, () => lanAddresses())
  assert.deepEqual(out, [{ name: 'WLAN', address: '192.168.31.10' }])
})
