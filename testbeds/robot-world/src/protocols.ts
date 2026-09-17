import { common, minimal, MavLinkProtocolV2, MavLinkPacketSplitter, MavLinkPacketParser } from 'node-mavlink';
import type { MavLinkData, MavLinkPacket, MavLinkDataConstructor } from 'node-mavlink';
import type { ProtocolAdapter, ProtocolRecord, Vec3 } from './contracts.ts';
import { vec } from './contracts.ts';

export const enuToNed = (v: Vec3) => vec(v.y, v.x, -v.z);
export const nedToEnu = (v: Vec3) => vec(v.y, v.x, -v.z);

/** Real MAVLink v2 serialization, framing, CRC verification and dialect decoding. */
export class MavlinkCodec {
  private sender: MavLinkProtocolV2;
  private splitter = new MavLinkPacketSplitter();
  private parser = new MavLinkPacketParser();
  private received?: MavLinkPacket;
  private seq = 0;
  frames = 0;
  bytes = 0;
  lastHex = '';
  constructor(systemId = 255, componentId = 190) {
    this.sender = new MavLinkProtocolV2(systemId, componentId);
    this.splitter.pipe(this.parser);
    this.parser.on('data', (packet: MavLinkPacket) => { this.received = packet; });
  }
  encode(message: MavLinkData) { return this.sender.serialize(message, this.seq++ % 256); }
  decode<T extends MavLinkData>(frame: Buffer, type: MavLinkDataConstructor<T>): T {
    this.received = undefined;
    this.splitter.write(frame);
    const packet = this.received as MavLinkPacket | undefined;
    if (!packet || packet.header.msgid !== type.MSG_ID) throw new Error('invalid_mavlink_frame');
    this.frames++; this.bytes += frame.length; this.lastHex = frame.toString('hex');
    return packet.protocol.data(packet.payload, type);
  }
  roundtrip<T extends MavLinkData>(message: T, type: MavLinkDataConstructor<T>): T { return this.decode(this.encode(message), type); }
  close() { this.splitter.destroy(); this.parser.destroy(); }
}

export function mavlinkProtocol(): ProtocolAdapter {
  const codec = new MavlinkCodec();
  const vehicle = new MavlinkCodec(1, 1);
  let lastHeartbeat = -1000;
  let commandFrames = 0;
  let record: (event: ProtocolRecord) => void = () => {};
  return {
    id: 'mavlink',
    setRecorder(listener) { record = listener; },
    execute(kind, args, robot, simMs) {
      if (kind !== 'goto') throw new Error('unsupported_mavlink_command');
      const p = enuToNed(vec(Number(args.x), Number(args.y), Number(args.z)));
      const message = new common.SetPositionTargetLocalNed();
      Object.assign(message, { timeBootMs: Math.round(simMs), targetSystem: 1, targetComponent: 1,
        coordinateFrame: 1, typeMask: 3576, x: p.x, y: p.y, z: p.z });
      const decoded = codec.roundtrip(message, common.SetPositionTargetLocalNed);
      record({ direction: 'TX', message: 'SET_POSITION_TARGET_LOCAL_NED', simMs, decoded,
        hex: codec.lastHex, bytes: codec.lastHex.length / 2, frame: 'NED; sender 255/190 → vehicle 1/1' });
      if (decoded.targetSystem !== 1 || decoded.targetComponent !== 1 || decoded.coordinateFrame !== 1 || Number(decoded.typeMask) !== 3576)
        throw new Error('unsupported_mavlink_setpoint');
      const enu = nedToEnu(decoded);
      robot.apply('goto', { ...args, ...enu }); commandFrames++;
    },
    telemetry(robot, simMs) {
      if (simMs - lastHeartbeat >= 1000) {
        const heartbeat = new minimal.Heartbeat();
        Object.assign(heartbeat, { type: 2, autopilot: 0, systemStatus: 4, mavlinkVersion: 3 });
        const decoded = vehicle.roundtrip(heartbeat, minimal.Heartbeat); lastHeartbeat = simMs;
        record({ direction: 'RX', message: 'HEARTBEAT', simMs, decoded, hex: vehicle.lastHex, bytes: vehicle.lastHex.length / 2 });
      }
      const s = robot.state(), p = enuToNed(s.position), v = enuToNed(s.velocity);
      const message = new common.LocalPositionNed();
      Object.assign(message, { timeBootMs: Math.round(simMs), ...p, vx: v.x, vy: v.y, vz: v.z });
      const d = vehicle.roundtrip(message, common.LocalPositionNed);
      record({ direction: 'RX', message: 'LOCAL_POSITION_NED', simMs, decoded: d,
        hex: vehicle.lastHex, bytes: vehicle.lastHex.length / 2, frame: 'NED; vehicle 1/1 → host' });
      return { frame: 'LOCAL_NED', position: { x: d.x, y: d.y, z: d.z }, velocity: { x: d.vx, y: d.vy, z: d.vz }, timeBootMs: d.timeBootMs };
    },
    stats: () => ({ transport: 'in-process binary loopback', frames: codec.frames + vehicle.frames, commandFrames,
      bytes: codec.bytes + vehicle.bytes, lastHex: vehicle.lastHex, lastCommandHex: codec.lastHex }),
    close: () => { codec.close(); vehicle.close(); }
  };
}

export function directProtocol(): ProtocolAdapter {
  let commands = 0;
  let record: (event: ProtocolRecord) => void = () => {};
  return { id: 'direct', setRecorder(listener) { record = listener; }, execute(kind, args, robot, simMs) {
      record({ direction: 'TX', message: kind, simMs, decoded: { kind, args }, frame: 'Direct / ENU' }); robot.apply(kind, args); commands++; },
    telemetry: (robot, simMs) => { const s = robot.state(), data = { frame: 'ENU', position: { ...s.position }, velocity: { ...s.velocity } };
      record({ direction: 'RX', message: 'telemetry', simMs, decoded: data, frame: 'Direct / ENU' }); return data; },
    stats: () => ({ commands }), close() {} };
}
export const protocols = new Map<string, () => ProtocolAdapter>([['mavlink', mavlinkProtocol], ['direct', directProtocol]]);
