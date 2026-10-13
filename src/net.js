import dgram from 'node:dgram';

/**
 * Which of our addresses does the OS use to reach `targetIp`?
 * Connecting a UDP socket sends nothing; it just runs the routing table lookup.
 * This picks the right NIC on multi-homed hosts (VPN, Docker bridges, VLANs) -
 * unlike os.hostname(), which most renderers cannot resolve at all.
 */
export function localAddressFor(targetIp) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.on('error', (e) => { s.close(); reject(e); });
    s.connect(9, targetIp, () => {
      const { address } = s.address();
      s.close();
      resolve(address);
    });
  });
}
