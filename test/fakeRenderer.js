// A fake UPnP MediaRenderer that exposes itself as an EMBEDDED device (like Sonos/AVRs)
// and uses a non-standard serviceId spelling - both broke the original upnpTube.
import http from 'node:http';

const ACTIONS = {
  AVTransport: {
    SetAVTransportURI: [['InstanceID', 'in'], ['CurrentURI', 'in'], ['CurrentURIMetaData', 'in']],
    Play: [['InstanceID', 'in'], ['Speed', 'in']],
    Pause: [['InstanceID', 'in']],
    Stop: [['InstanceID', 'in']],
    Seek: [['InstanceID', 'in'], ['Unit', 'in'], ['Target', 'in']],
    GetTransportInfo: [['InstanceID', 'in'], ['CurrentTransportState', 'out'], ['CurrentTransportStatus', 'out'], ['CurrentSpeed', 'out']],
    GetPositionInfo: [['InstanceID', 'in'], ['TrackDuration', 'out'], ['RelTime', 'out']],
  },
  RenderingControl: {
    GetVolume: [['InstanceID', 'in'], ['Channel', 'in'], ['CurrentVolume', 'out']],
    SetVolume: [['InstanceID', 'in'], ['Channel', 'in'], ['DesiredVolume', 'in']],
  },
  ConnectionManager: {
    GetProtocolInfo: [['Source', 'out'], ['Sink', 'out']],
  },
};

const scpd = (svc) => `<?xml version="1.0"?><scpd xmlns="urn:schemas-upnp-org:service-1-0"><actionList>${
  Object.entries(ACTIONS[svc]).map(([a, args]) => `<action><name>${a}</name><argumentList>${
    args.map(([n, d]) => `<argument><name>${n}</name><direction>${d}</direction></argument>`).join('')
  }</argumentList></action>`).join('')}</actionList></scpd>`;

export function startFakeRenderer({ sink = 'http-get:*:audio/mpeg:*,http-get:*:audio/mp4:*', neverPlay = false, bareFaultOn = [] } = {}) {
  const calls = [];
  const state = { transport: 'STOPPED', volume: 30 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.url === '/desc.xml') {
        const svc = (s) => `<service><serviceType>urn:schemas-upnp-org:service:${s}:1</serviceType>
          <serviceId>urn:schemas-upnp-org:serviceId:${s}</serviceId>
          <SCPDURL>/scpd/${s}.xml</SCPDURL><controlURL>/ctl/${s}</controlURL><eventSubURL>/evt/${s}</eventSubURL></service>`;
        res.end(`<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device>
          <deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType><friendlyName>Living Room</friendlyName>
          <manufacturer>Acme</manufacturer><modelName>Box</modelName><UDN>uuid:root</UDN>
          <deviceList><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
            <friendlyName>Living Room Speaker</friendlyName><manufacturer>Acme</manufacturer><modelName>Speaker 1</modelName>
            <UDN>uuid:fake-renderer</UDN><serviceList>${svc('AVTransport')}${svc('RenderingControl')}${svc('ConnectionManager')}</serviceList>
          </device></deviceList></device></root>`);
        return;
      }
      const m = /^\/scpd\/(\w+)\.xml$/.exec(req.url);
      if (m) return res.end(scpd(m[1]));
      const c = /^\/ctl\/(\w+)$/.exec(req.url);
      if (c) {
        const action = (req.headers.soapaction || '').replace(/"/g, '').split('#')[1];
        calls.push({ service: c[1], action, body, contentLength: Number(req.headers['content-length']), bytes: Buffer.byteLength(body) });
        // Some real renderers answer errors with a bare 500 and no UPnPError body.
        if (bareFaultOn.includes(action)) return res.writeHead(500).end('<html>Internal Error</html>');
        let out = '';
        if (action === 'Play') state.transport = neverPlay ? 'STOPPED' : 'PLAYING';
        if (action === 'Stop') state.transport = 'STOPPED';
        if (action === 'Pause') state.transport = 'PAUSED_PLAYBACK';
        if (action === 'GetTransportInfo') out = `<CurrentTransportState>${state.transport}</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed>`;
        if (action === 'GetPositionInfo') out = '<TrackDuration>0:03:30</TrackDuration><RelTime>0:01:05</RelTime>';
        if (action === 'GetVolume') out = `<CurrentVolume>${state.volume}</CurrentVolume>`;
        if (action === 'GetProtocolInfo') out = `<Source></Source><Sink>${sink}</Sink>`;
        res.setHeader('Content-Type', 'text/xml');
        res.end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
          <u:${action}Response xmlns:u="urn:schemas-upnp-org:service:${c[1]}:1">${out}</u:${action}Response></s:Body></s:Envelope>`);
        return;
      }
      res.writeHead(404).end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, calls, state, location: `http://127.0.0.1:${server.address().port}/desc.xml`,
  })));
}
