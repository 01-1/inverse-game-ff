import * as THREE from 'three';
import type { BuildingDef, DayRecord, DistrictDef, EdgeDef, NodeDef } from '../engine/types';
import type { CreateRenderApp, PickTarget, RenderApp, RenderMode } from './types';

const WORLD_SCALE = 1.15;
const ROAD_WIDTH = 5;
const BUILDING_SPACING = 9;
const PICK_DISTANCE = 42;

type Targeted = THREE.Object3D & { userData: { pick?: Exclude<PickTarget, null> } };
type TargetedMesh = THREE.Mesh & { userData: { pick?: Exclude<PickTarget, null> } };

function planToWorld(n: Pick<NodeDef, 'x' | 'y'>): THREE.Vector3 {
  return new THREE.Vector3((n.x - 120) * WORLD_SCALE, 0, (n.y - 80) * WORLD_SCALE);
}

function colorForKind(kind: BuildingDef['kind']): number {
  switch (kind) {
    case 'shop':
      return 0xd9b45f;
    case 'depot':
      return 0x75a8c7;
    case 'warehouse':
      return 0x9d8f78;
    case 'sensorStation':
      return 0x80cbc4;
    case 'datacenter':
      return 0xdf7d70;
    case 'civic':
      return 0xbfc6d4;
    case 'plaza':
      return 0x7aa36f;
    case 'housing':
      return 0x8f9aa7;
  }
}

function equalTarget(a: PickTarget, b: PickTarget): boolean {
  return a?.kind === b?.kind && a?.id === b?.id;
}

class DistrictRenderApp implements RenderApp {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(68, 1, 0.1, 900);
  private readonly clock = new THREE.Clock();
  private readonly raycaster = new THREE.Raycaster();
  private readonly keys = new Set<string>();
  private readonly nodeById = new Map<string, NodeDef>();
  private readonly edgeById = new Map<string, EdgeDef>();
  private readonly pickables: Targeted[] = [];
  private readonly roadMeshes = new Map<string, THREE.Mesh>();
  private readonly buildingMeshes = new Map<string, THREE.Object3D>();
  private readonly trafficSprites: THREE.Mesh[] = [];
  private readonly deliverySprites: { mesh: THREE.Mesh; route: THREE.Vector3[]; phase: number }[] = [];
  private readonly pickCbs: ((t: PickTarget) => void)[] = [];
  private readonly lockCbs: ((locked: boolean) => void)[] = [];
  private running = false;
  private yaw = 0;
  private pitch = -0.18;
  private pick: PickTarget = null;
  private highlight: PickTarget = null;
  private dayData: DayRecord | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly district: DistrictDef,
  ) {
    for (const n of district.nodes) this.nodeById.set(n.id, n);
    for (const e of district.edges) this.edgeById.set(e.id, e);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = false;
    container.appendChild(this.renderer.domElement);
    this.camera.position.set(-95, 28, -82);
    this.buildScene();
    this.resize();
    window.addEventListener('resize', this.resize);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onPointerLock);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.renderer.setAnimationLoop(() => this.frame());
  }

  dispose(): void {
    this.running = false;
    this.renderer.setAnimationLoop(null);
    this.renderer.domElement.remove();
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onPointerLock);
  }

  setMode(mode: RenderMode): void {
    this.scene.background = new THREE.Color(mode === 'sandbox' ? 0x071822 : 0xb8d0dc);
    this.scene.fog = new THREE.Fog(mode === 'sandbox' ? 0x071822 : 0xb8d0dc, 140, 360);
    for (const obj of [...this.roadMeshes.values(), ...this.buildingMeshes.values()]) {
      obj.traverse((child) => {
        const mat = (child as THREE.Mesh).material;
        if (mat instanceof THREE.MeshStandardMaterial) {
          mat.wireframe = mode === 'sandbox';
          mat.opacity = mode === 'sandbox' ? 0.72 : 1;
          mat.transparent = mode === 'sandbox';
          mat.emissive.setHex(mode === 'sandbox' ? 0x083c4a : 0x000000);
        }
      });
    }
  }

  setDayData(rec: DayRecord | null): void {
    this.dayData = rec;
    for (const [id, mesh] of this.roadMeshes) {
      const ratio = rec?.congestion[id] ?? 0.65;
      const mat = mesh.material;
      if (mat instanceof THREE.MeshStandardMaterial) {
        mat.color.setHex(ratio > 1.05 ? 0xc96b5a : ratio > 0.85 ? 0xc1a56a : 0x5f6870);
      }
    }
    this.deliverySprites.length = 0;
    if (rec) {
      for (const d of rec.deliveries.slice(0, 24)) {
        const route = d.route.flatMap((edgeId) => {
          const e = this.edgeById.get(edgeId);
          const a = e ? this.nodeById.get(e.a) : undefined;
          return a ? [planToWorld(a)] : [];
        });
        const lastEdge = this.edgeById.get(d.route[d.route.length - 1] ?? '');
        const lastNode = lastEdge ? this.nodeById.get(lastEdge.b) : undefined;
        if (lastNode) route.push(planToWorld(lastNode));
        if (route.length > 1) {
          const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(2.4, 1.4, 4),
            new THREE.MeshStandardMaterial({ color: d.to === 'W7' ? 0xffc857 : 0xeeeeee, emissive: d.to === 'W7' ? 0x332100 : 0 }),
          );
          this.scene.add(mesh);
          this.deliverySprites.push({ mesh, route, phase: Math.random() });
        }
      }
    }
  }

  getPickTarget(): PickTarget {
    return this.pick;
  }

  onPickChange(cb: (t: PickTarget) => void): void {
    this.pickCbs.push(cb);
  }

  setHighlight(t: PickTarget): void {
    this.highlight = t;
    this.applyHighlights();
  }

  lock(): void {
    void this.renderer.domElement.requestPointerLock();
  }

  unlock(): void {
    if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock();
  }

  isLocked(): boolean {
    return document.pointerLockElement === this.renderer.domElement;
  }

  onLockChange(cb: (locked: boolean) => void): void {
    this.lockCbs.push(cb);
  }

  private buildScene(): void {
    this.scene.background = new THREE.Color(0xb8d0dc);
    this.scene.fog = new THREE.Fog(0xb8d0dc, 140, 360);
    this.scene.add(new THREE.HemisphereLight(0xf4f7ff, 0x4d5d4d, 2.4));
    const sun = new THREE.DirectionalLight(0xffffff, 2.1);
    sun.position.set(80, 120, 30);
    this.scene.add(sun);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(380, 280),
      new THREE.MeshStandardMaterial({ color: 0x55665c, roughness: 0.95 }),
    );
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);

    for (const e of this.district.edges) this.addRoad(e);
    for (const b of this.district.buildings) this.addBuilding(b);
    this.addAmbientTraffic();
    this.addCrosshair();
  }

  private addRoad(e: EdgeDef): void {
    const a = this.nodeById.get(e.a);
    const b = this.nodeById.get(e.b);
    if (!a || !b) return;
    const pa = planToWorld(a);
    const pb = planToWorld(b);
    const mid = pa.clone().lerp(pb, 0.5);
    const length = pa.distanceTo(pb);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_WIDTH, 0.18, length),
      new THREE.MeshStandardMaterial({ color: 0x5f6870, roughness: 0.88 }),
    ) as TargetedMesh;
    mesh.position.copy(mid);
    mesh.position.y = 0.04;
    mesh.rotation.y = Math.atan2(pb.x - pa.x, pb.z - pa.z);
    mesh.userData.pick = { kind: 'road', id: e.id };
    this.scene.add(mesh);
    this.pickables.push(mesh);
    this.roadMeshes.set(e.id, mesh);
  }

  private addBuilding(b: BuildingDef): void {
    const n = this.nodeById.get(b.node);
    if (!n) return;
    const base = planToWorld(n);
    const hash = [...b.id].reduce((s, c) => s + c.charCodeAt(0), 0);
    const angle = (hash % 8) * (Math.PI / 4);
    const offset = new THREE.Vector3(Math.cos(angle) * BUILDING_SPACING, 0, Math.sin(angle) * BUILDING_SPACING);
    const h = b.kind === 'datacenter' ? 13 : b.kind === 'warehouse' || b.kind === 'depot' ? 8 : b.kind === 'sensorStation' ? 10 : 5 + (hash % 4);
    const w = b.kind === 'plaza' ? 12 : b.kind === 'warehouse' ? 11 : 7;
    const group = new THREE.Group() as Targeted;
    const mesh = new THREE.Mesh(
      b.kind === 'sensorStation' ? new THREE.CylinderGeometry(1.8, 2.5, h, 6) : new THREE.BoxGeometry(w, h, w),
      new THREE.MeshStandardMaterial({ color: colorForKind(b.kind), roughness: 0.82, flatShading: true }),
    ) as Targeted;
    mesh.position.y = h / 2;
    mesh.userData.pick = { kind: 'building', id: b.id };
    group.userData.pick = mesh.userData.pick;
    group.add(mesh);
    if (b.kind === 'datacenter' || b.kind === 'sensorStation') {
      const mast = new THREE.Mesh(new THREE.ConeGeometry(2.2, 4, 5), new THREE.MeshStandardMaterial({ color: 0xf2f7ff, emissive: 0x142232 }));
      mast.position.y = h + 2.2;
      group.add(mast);
    }
    group.position.copy(base.add(offset));
    group.rotation.y = angle * 0.5;
    this.scene.add(group);
    this.pickables.push(mesh);
    this.buildingMeshes.set(b.id, group);
  }

  private addAmbientTraffic(): void {
    const geo = new THREE.BoxGeometry(1.8, 1, 3.2);
    for (let i = 0; i < 46; i++) {
      const mat = new THREE.MeshStandardMaterial({ color: i % 4 === 0 ? 0xf4d35e : 0x2d9cdb });
      const mesh = new THREE.Mesh(geo, mat);
      this.scene.add(mesh);
      this.trafficSprites.push(mesh);
    }
  }

  private addCrosshair(): void {
    const reticle = document.createElement('div');
    reticle.className = 'reticle';
    this.container.appendChild(reticle);
  }

  private frame(): void {
    const dt = Math.min(0.04, this.clock.getDelta());
    this.moveCamera(dt);
    this.animateTraffic(performance.now() / 1000);
    this.updatePick();
    this.renderer.render(this.scene, this.camera);
  }

  private moveCamera(dt: number): void {
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    if (!this.isLocked()) return;
    const speed = (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 38 : 24) * dt;
    const forward = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    if (this.keys.has('KeyW')) this.camera.position.addScaledVector(forward, speed);
    if (this.keys.has('KeyS')) this.camera.position.addScaledVector(forward, -speed);
    if (this.keys.has('KeyD')) this.camera.position.addScaledVector(right, speed);
    if (this.keys.has('KeyA')) this.camera.position.addScaledVector(right, -speed);
    if (this.keys.has('Space')) this.camera.position.y += speed;
    if (this.keys.has('KeyQ')) this.camera.position.y -= speed;
    if (this.keys.has('KeyE')) this.camera.position.y += speed;
    this.camera.position.y = THREE.MathUtils.clamp(this.camera.position.y, 7, 70);
    this.camera.position.x = THREE.MathUtils.clamp(this.camera.position.x, -170, 170);
    this.camera.position.z = THREE.MathUtils.clamp(this.camera.position.z, -120, 130);
  }

  private animateTraffic(t: number): void {
    const edges = this.district.edges;
    for (let i = 0; i < this.trafficSprites.length; i++) {
      const edge = edges[i % edges.length];
      if (!edge) continue;
      const a = this.nodeById.get(edge.a);
      const b = this.nodeById.get(edge.b);
      if (!a || !b) continue;
      const ratio = this.dayData?.congestion[edge.id] ?? 0.7;
      const p = (t * (0.08 + ratio * 0.06) + i * 0.137) % 1;
      const pa = planToWorld(a);
      const pb = planToWorld(b);
      const mesh = this.trafficSprites[i]!;
      mesh.position.copy(pa.lerp(pb, p));
      mesh.position.y = 0.9;
      mesh.rotation.y = Math.atan2(pb.x - pa.x, pb.z - pa.z);
      mesh.visible = ratio > 0.18;
    }
    for (const del of this.deliverySprites) {
      const f = (t * 0.18 + del.phase) % 1;
      const idx = Math.min(del.route.length - 2, Math.floor(f * (del.route.length - 1)));
      const local = f * (del.route.length - 1) - idx;
      const a = del.route[idx];
      const b = del.route[idx + 1];
      if (!a || !b) continue;
      del.mesh.position.copy(a.clone().lerp(b, local));
      del.mesh.position.y = 1.35;
      del.mesh.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
    }
  }

  private updatePick(): void {
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const hit = this.raycaster.intersectObjects(this.pickables, false).find((h) => h.distance <= PICK_DISTANCE);
    const next = (hit?.object as Targeted | undefined)?.userData.pick ?? null;
    if (!equalTarget(this.pick, next)) {
      this.pick = next;
      for (const cb of this.pickCbs) cb(next);
      this.applyHighlights();
    }
  }

  private applyHighlights(): void {
    const selected = this.highlight ?? this.pick;
    for (const [id, mesh] of this.roadMeshes) this.setEmissive(mesh, equalTarget(selected, { kind: 'road', id }) ? 0x425f28 : 0);
    for (const [id, obj] of this.buildingMeshes) {
      obj.traverse((child) => this.setEmissive(child, equalTarget(selected, { kind: 'building', id }) ? 0x334721 : 0));
    }
  }

  private setEmissive(obj: THREE.Object3D, hex: number): void {
    const mat = (obj as THREE.Mesh).material;
    if (mat instanceof THREE.MeshStandardMaterial) mat.emissive.setHex(hex);
  }

  private readonly resize = (): void => {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    this.keys.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.isLocked()) return;
    this.yaw -= e.movementX * 0.0022;
    this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.0022, -1.25, 0.85);
  };

  private readonly onPointerLock = (): void => {
    for (const cb of this.lockCbs) cb(this.isLocked());
  };
}

export const createRenderApp: CreateRenderApp = (container, district) => new DistrictRenderApp(container, district);
