// A fake UPnP MediaRenderer that exposes itself as an EMBEDDED device (like Sonos/AVRs)
// and uses a non-standard serviceId spelling - both broke the original upnpTube (which this project forked).
import http from 'node:http';

const ACTIONS = {
  AVTransport: {
    SetAVTransportURI: [['InstanceID', 'in'], ['CurrentURI', 'in'], ['CurrentURIMetaData', 'in']],
    SetNextAVTransportURI: [['InstanceID', 'in'], ['NextURI', 'in'], ['NextURIMetaData', 'in']],
    GetMediaInfo: [['InstanceID', 'in'], ['CurrentURI', 'out']],
    Play: [['InstanceID', 'in'], ['Speed', 'in']],
    Pause: [['InstanceID', 'in']],
    Stop: [['InstanceID', 'in']],
    Seek: [['InstanceID', 'in'], ['Unit', 'in'], ['Target', 'in']],
    GetTransportInfo: [['InstanceID', 'in'], ['CurrentTransportState', 'out'], ['CurrentTransportStatus', 'out'], ['CurrentSpeed', 'out']],
    GetPositionInfo: [['InstanceID', 'in'], ['TrackDuration', 'out'], ['TrackURI', 'out'], ['RelTime', 'out']],
  },
  RenderingControl: {
    GetVolume: [['InstanceID', 'in'], ['Channel', 'in'], ['CurrentVolume', 'out']],
    SetVolume: [['InstanceID', 'in'], ['Channel', 'in'], ['DesiredVolume', 'in']],
    GetMute: [['InstanceID', 'in'], ['Channel', 'in'], ['CurrentMute', 'out']],
  },
  ConnectionManager: {
    GetProtocolInfo: [['Source', 'out'], ['Sink', 'out']],
  },
};

// Optional actions, listed only when a test turns them on.
const EXTRA_ACTIONS = {
  GetVolumeDB: [['InstanceID', 'in'], ['Channel', 'in'], ['CurrentVolume', 'out']],
  GetVolumeDBRange: [['InstanceID', 'in'], ['Channel', 'in'], ['MinValue', 'out'], ['MaxValue', 'out']],
  GetCurrentTransportActions: [['InstanceID', 'in'], ['Actions', 'out']],
};

const scpd = (svc, volumeRange, extra = []) => `<?xml version="1.0"?><scpd xmlns="urn:schemas-upnp-org:service-1-0"><actionList>${
  [...Object.entries(ACTIONS[svc]), ...extra.map((a) => [a, EXTRA_ACTIONS[a]])].map(([a, args]) => `<action><name>${a}</name><argumentList>${
    args.map(([n, d]) => `<argument><name>${n}</name><direction>${d}</direction></argument>`).join('')
  }</argumentList></action>`).join('')}</actionList>${svc === 'RenderingControl' && volumeRange
  ? '<serviceStateTable><stateVariable sendEvents="no"><name>Mute</name><dataType>boolean</dataType></stateVariable>'
    + `<stateVariable sendEvents="no"><name>Volume</name><dataType>ui2</dataType><allowedValueRange><minimum>${volumeRange[0]}</minimum>`
    + `<maximum>${volumeRange[1]}</maximum><step>1</step></allowedValueRange></stateVariable></serviceStateTable>` : ''}</scpd>`;

export function startFakeRenderer({ sink = 'http-get:*:audio/mpeg:*,http-get:*:audio/mp4:*', neverPlay = false, bareFaultOn = [], noGapless = false,
  volumeRange = null, port = 0, volumeDb = null, volumeDbRange = null, transportActions = null, page = false, yamaha = null } = {}) {
  const calls = [];
  const state = { transport: 'STOPPED', volume: 30, muted: false, currentUri: '', nextUri: '', metaData: '' };
  // Yamaha Extended Control (MusicCast): yamaha = { announce, main, tuner, netusb, broken }; tests change
  // state.yxc to switch inputs. announce: false leaves it out of the description (found by the standard path).
  state.yxc = yamaha && {
    main: { power: 'on', input: 'server', input_text: 'SERVER', volume: 12, max_volume: 161, mute: false,
      actual_volume: { mode: 'db', value: -74.5, unit: 'dB' }, ...yamaha.main },
    tuner: yamaha.tuner ?? { band: 'fm', fm: { freq: 103900 }, rds: { program_service: '' } },
    netusb: yamaha.netusb ?? { input: 'server', playback: 'stop', track: '', artist: '', album: '' },
    broken: Boolean(yamaha.broken),
  };
  const unescape = (x) => x.replace(/&amp;/g, '&');
  const xml = (x) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const extra = {
    RenderingControl: volumeDb != null ? ['GetVolumeDB', 'GetVolumeDBRange'] : [],
    AVTransport: transportActions != null ? ['GetCurrentTransportActions'] : [],
  };
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
          <manufacturer>${yamaha ? 'Yamaha Corporation' : 'Acme'}</manufacturer><modelName>Box</modelName><UDN>uuid:root</UDN>
          ${page ? `<presentationURL>/web/index.html</presentationURL><iconList>
            <icon><mimetype>image/jpeg</mimetype><width>120</width><height>120</height><depth>24</depth><url>/icon-120.jpg</url></icon>
            <icon><mimetype>image/png</mimetype><width>48</width><height>48</height><depth>24</depth><url>/icon-48.png</url></icon>
          </iconList>` : ''}
          <deviceList><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
            <friendlyName>Living Room Speaker</friendlyName><manufacturer>${yamaha ? 'Yamaha Corporation' : 'Acme'}</manufacturer><modelName>Speaker 1</modelName>${yamaha ? '<modelNumber>1</modelNumber>' : ''}
            <UDN>uuid:fake-renderer</UDN><serviceList>${svc('AVTransport')}${svc('RenderingControl')}${svc('ConnectionManager')}</serviceList>
          </device></deviceList></device>${yamaha && yamaha.announce !== false
  ? `<yamaha:X_device xmlns:yamaha="urn:schemas-yamaha-com:device-1-0"><yamaha:X_URLBase>http://${req.headers.host}/</yamaha:X_URLBase>
    <yamaha:X_serviceList><yamaha:X_service><yamaha:X_specType>urn:schemas-yamaha-com:service-1-0</yamaha:X_specType>
    <yamaha:X_yxcControlURL>/YamahaExtendedControl/v1/</yamaha:X_yxcControlURL></yamaha:X_service></yamaha:X_serviceList></yamaha:X_device>`
  : ''}</root>`);
        return;
      }
      const m = /^\/scpd\/(\w+)\.xml$/.exec(req.url);
      if (m) return res.end(scpd(m[1], volumeRange, extra[m[1]]));
      if (page && req.url === '/icon-48.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
      }
      const y = /^\/YamahaExtendedControl\/v1\/(main|tuner|netusb)\/(getStatus|getPlayInfo)$/.exec(req.url);
      if (y && state.yxc) {
        calls.push({ service: 'YXC', action: `${y[1]}/${y[2]}` });
        if (state.yxc.broken) return res.writeHead(500).end();
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ response_code: 0, ...state.yxc[y[1]] }));
      }
      if (state.yxc && req.url.startsWith('/YamahaRemoteControl/AlbumART/')) {
        calls.push({ service: 'YXC', action: 'albumart', url: req.url });
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(Buffer.from(`89504e470d0a1a0a${Buffer.from(req.url).toString('hex')}`, 'hex'));
      }
      const c = /^\/ctl\/(\w+)$/.exec(req.url);
      if (c) {
        const action = (req.headers.soapaction || '').replace(/"/g, '').split('#')[1];
        calls.push({ service: c[1], action, body, contentLength: Number(req.headers['content-length']), bytes: Buffer.byteLength(body) });
        // Some real renderers answer errors with a bare 500 and no UPnPError body.
        if (bareFaultOn.includes(action)) return res.writeHead(500).end('<html>Internal Error</html>');
        let out = '';
        if (action === 'SetNextAVTransportURI' && noGapless) {
          res.writeHead(500, { 'Content-Type': 'text/xml' });
          return res.end('<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>'
            + '<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>401</errorCode>'
            + '<errorDescription>Invalid Action</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>');
        }
        if (action === 'SetAVTransportURI') state.currentUri = unescape(/<CurrentURI>(.*?)<\/CurrentURI>/.exec(body)?.[1] ?? '');
        if (action === 'SetNextAVTransportURI') state.nextUri = unescape(/<NextURI>(.*?)<\/NextURI>/.exec(body)?.[1] ?? '');
        if (action === 'SetVolume') state.volume = Number(/<DesiredVolume>(\d+)</.exec(body)?.[1] ?? state.volume);
        if (action === 'SetMute') state.muted = /<DesiredMute>(1|true)</.test(body);
        if (action === 'Play') state.transport = neverPlay ? 'STOPPED' : 'PLAYING';
        if (action === 'Stop') state.transport = 'STOPPED';
        if (action === 'Pause') state.transport = 'PAUSED_PLAYBACK';
        if (action === 'GetTransportInfo') out = `<CurrentTransportState>${state.transport}</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed>`;
        if (action === 'GetPositionInfo') out = `<TrackDuration>${state.trackDuration ?? '0:03:30'}</TrackDuration><TrackURI>${state.reportedUri ?? state.currentUri}</TrackURI><RelTime>${state.relTime ?? '0:01:05'}</RelTime>`
          + `<TrackMetaData>${xml(state.metaData)}</TrackMetaData>`;
        if (action === 'GetMediaInfo') out = `<CurrentURI>${xml(state.currentUri)}</CurrentURI>`;
        if (action === 'GetVolumeDB') out = `<CurrentVolume>${volumeDb}</CurrentVolume>`;
        if (action === 'GetVolumeDBRange') out = `<MinValue>${volumeDbRange?.[0] ?? -20480}</MinValue><MaxValue>${volumeDbRange?.[1] ?? 0}</MaxValue>`;
        if (action === 'GetCurrentTransportActions') out = `<Actions>${transportActions}</Actions>`;
        if (action === 'GetVolume') out = `<CurrentVolume>${state.volume}</CurrentVolume>`;
        if (action === 'GetMute') out = `<CurrentMute>${state.muted ? 1 : 0}</CurrentMute>`;
        if (action === 'GetProtocolInfo') out = `<Source></Source><Sink>${sink}</Sink>`;
        res.setHeader('Content-Type', 'text/xml');
        res.end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
          <u:${action}Response xmlns:u="urn:schemas-upnp-org:service:${c[1]}:1">${out}</u:${action}Response></s:Body></s:Envelope>`);
        return;
      }
      res.writeHead(404).end();
    });
  });
  // Simulate the renderer reaching the end of the track and playing on into the queued one.
  const advance = () => { state.currentUri = state.nextUri; state.nextUri = ''; state.transport = 'PLAYING'; };
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    server, calls, state, advance, location: `http://127.0.0.1:${server.address().port}/desc.xml`,
  })));
}
