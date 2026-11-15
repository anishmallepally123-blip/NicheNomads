// A 3D map of the challenge targets around the Sun. Drag to orbit, scroll or
// pinch to zoom, click a star to fly to it and open it in the sky viewer.
// three.js lives only in this lazily loaded chunk, so the viewer stays light.
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CATEGORIES, OBJECTS, position, scaleLy, type Category, type MapObject } from "./objects";
import "./space3d.css";

const RINGS = [10, 100, 1000];
const HOME_CAM = new THREE.Vector3(17, 12, 24);

/** CSS colour (oklch tokens included) to a three.js colour, via a 1px canvas. */
function cssColor(token: string): THREE.Color {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim() || "#fff";
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.fillStyle = raw;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return new THREE.Color(r / 255, g / 255, b / 255);
}

function glowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.2, "rgba(255,255,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

const fmtLy = (ly: number) => `${ly < 20 ? ly.toFixed(1) : Math.round(ly).toLocaleString()} light-years`;

interface Api { flyTo(o: MapObject | null): void; show(c: Category, on: boolean): void }

interface Props {
  /** Compact version that sits inside the homepage instead of filling the window. */
  embedded?: boolean;
  /** Open an object in the sky viewer. Without it the page navigates by URL. */
  onOpen?: (o: MapObject) => void;
}

export default function Space3D({ embedded = false, onOpen }: Props) {
  const mount = useRef<HTMLDivElement>(null);
  const labels = useRef<Record<string, HTMLElement | null>>({});
  const api = useRef<Api | null>(null);
  const [selected, setSelected] = useState<MapObject | null>(null);
  const [shown, setShown] = useState<Record<Category, boolean>>({ movers: true, variables: true, landmarks: true });

  useEffect(() => {
    const el = mount.current!;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
    camera.position.copy(HOME_CAM);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.minDistance = 1.5;
    controls.maxDistance = 90;
    controls.autoRotate = !still;
    controls.autoRotateSpeed = 0.35;
    controls.addEventListener("start", () => { controls.autoRotate = false; });
    // On the homepage the mouse wheel should scroll the page until someone
    // actually starts using the map.
    if (embedded) {
      controls.enableZoom = false;
      controls.addEventListener("start", () => { controls.enableZoom = true; });
      renderer.domElement.addEventListener("pointerleave", () => { controls.enableZoom = false; });
    }

    const disposables: { dispose(): void }[] = [];
    const keep = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x);

    // Background stars, fixed far away.
    const starPos = new Float32Array(1800 * 3);
    for (let i = 0; i < 1800; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(600 + Math.random() * 200);
      starPos.set([v.x, v.y, v.z], i * 3);
    }
    const starGeo = keep(new THREE.BufferGeometry());
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    scene.add(new THREE.Points(starGeo, keep(new THREE.PointsMaterial({ color: cssColor("--color-faint"), size: 1.4, sizeAttenuation: false }))));

    // The Sun with a soft glow.
    const glow = keep(glowTexture());
    const sunColor = cssColor("--color-accent");
    scene.add(new THREE.Mesh(keep(new THREE.SphereGeometry(0.32, 24, 16)), keep(new THREE.MeshBasicMaterial({ color: sunColor }))));
    const sunGlow = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: glow, color: sunColor, transparent: true, depthWrite: false })));
    sunGlow.scale.setScalar(2);
    scene.add(sunGlow);

    // Distance rings in the plane of Earth's equator.
    const ringMat = keep(new THREE.LineBasicMaterial({ color: cssColor("--color-rule-2"), transparent: true, opacity: 0.7 }));
    for (const ly of RINGS) {
      const pts = Array.from({ length: 129 }, (_, i) => {
        const a = (i / 128) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a) * scaleLy(ly), 0, Math.sin(a) * scaleLy(ly));
      });
      scene.add(new THREE.LineLoop(keep(new THREE.BufferGeometry().setFromPoints(pts)), ringMat));
    }

    // One group per category so filters are a single visibility switch.
    const groups = {} as Record<Category, THREE.Group>;
    const meshes: THREE.Mesh[] = [];
    const where: Record<string, THREE.Vector3> = { sun: new THREE.Vector3() };
    RINGS.forEach((ly) => { where[`ring${ly}`] = new THREE.Vector3(-scaleLy(ly) * 0.707, 0, scaleLy(ly) * 0.707); });
    const sphere = keep(new THREE.SphereGeometry(0.12, 20, 14));
    for (const c of CATEGORIES) {
      const g = new THREE.Group();
      const color = cssColor(c.color);
      const mat = keep(new THREE.MeshBasicMaterial({ color }));
      const stemMat = keep(new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35 }));
      const haloMat = keep(new THREE.SpriteMaterial({ map: glow, color, transparent: true, opacity: 0.6, depthWrite: false }));
      for (const o of OBJECTS.filter((x) => x.category === c.id)) {
        const p = new THREE.Vector3(...position(o));
        where[o.id] = p;
        const m = new THREE.Mesh(sphere, mat);
        m.position.copy(p);
        m.userData.id = o.id;
        meshes.push(m);
        const halo = new THREE.Sprite(haloMat);
        halo.position.copy(p);
        halo.scale.setScalar(0.75);
        // A stem down to the equator plane shows how far north or south it is.
        const stem = new THREE.Line(keep(new THREE.BufferGeometry().setFromPoints([p, new THREE.Vector3(p.x, 0, p.z)])), stemMat);
        g.add(m, halo, stem);
      }
      groups[c.id] = g;
      scene.add(g);
    }

    // Camera flights between objects.
    let flight: { p0: THREE.Vector3; p1: THREE.Vector3; t0v: THREE.Vector3; t1v: THREE.Vector3; start: number; dur: number } | null = null;
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
    api.current = {
      flyTo(o) {
        controls.autoRotate = false;
        const target = o ? where[o.id].clone() : new THREE.Vector3();
        const dir = camera.position.clone().sub(controls.target).normalize();
        const cam = o ? target.clone().add(dir.multiplyScalar(7)) : HOME_CAM.clone();
        flight = { p0: camera.position.clone(), p1: cam, t0v: controls.target.clone(), t1v: target, start: performance.now(), dur: still ? 1 : 1400 };
      },
      show(c, on) { groups[c].visible = on; },
    };

    // Click (not drag) on a star selects it.
    const ray = new THREE.Raycaster();
    let down: [number, number] | null = null;
    const onDown = (e: PointerEvent) => { down = [e.clientX, e.clientY]; };
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return;
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      ray.params.Points = { threshold: 0 };
      const hit = ray.intersectObjects(meshes.filter((m) => m.parent?.visible), false)[0];
      const o = hit && OBJECTS.find((x) => x.id === hit.object.userData.id);
      if (o) { setSelected(o); api.current?.flyTo(o); }
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    let w = 1, h = 1;
    const ro = new ResizeObserver(() => {
      w = el.clientWidth; h = el.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(el);

    const v = new THREE.Vector3();
    let raf = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (flight) {
        const t = Math.min(1, (now - flight.start) / flight.dur);
        const k = ease(t);
        camera.position.lerpVectors(flight.p0, flight.p1, k);
        controls.target.lerpVectors(flight.t0v, flight.t1v, k);
        if (t >= 1) flight = null;
      }
      controls.update();
      renderer.render(scene, camera);
      // Keep the HTML labels pinned to their stars.
      for (const [id, p] of Object.entries(where)) {
        const node = labels.current[id];
        if (!node) continue;
        v.copy(p).project(camera);
        const behind = v.z > 1;
        node.style.visibility = behind ? "hidden" : "";
        node.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px)`;
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      controls.dispose();
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      renderer.domElement.remove();
      api.current = null;
    };
  }, []);

  const pick = (o: MapObject | null) => { setSelected(o); api.current?.flyTo(o); };
  const toggle = (c: Category) => {
    const on = !shown[c];
    setShown({ ...shown, [c]: on });
    api.current?.show(c, on);
    if (!on && selected?.category === c) pick(null);
  };
  const viewerHref = (o: MapObject) => {
    const p = new URLSearchParams({ ra: o.ra.toFixed(6), dec: o.dec.toFixed(6) });
    if (o.band) p.set("band", String(o.band));
    return `${window.location.pathname}?${p}`;
  };
  const visible = OBJECTS.filter((o) => shown[o.category]);

  return (
    <div className={embedded ? "s3d is-embedded" : "s3d"}>
      <div className="s3d-stage" ref={mount}>
        <div className="s3d-labels" aria-hidden="true">
          <span className="s3d-label s3d-sun" ref={(n) => { labels.current.sun = n; }}>Sun</span>
          {RINGS.map((ly) => (
            <span key={ly} className="s3d-label s3d-ring" ref={(n) => { labels.current[`ring${ly}`] = n; }}>{ly.toLocaleString()} ly</span>
          ))}
          {OBJECTS.map((o) => (
            <span
              key={o.id}
              ref={(n) => { labels.current[o.id] = n; }}
              className={`s3d-label s3d-cat-${o.category}${selected?.id === o.id ? " is-on" : ""}`}
              hidden={!shown[o.category]}
            >
              {o.name}
            </span>
          ))}
        </div>
      </div>

      <header className="s3d-top">
        {embedded ? (
          <a className="s3d-full" href={`${window.location.pathname}?view=3d`}>Full screen</a>
        ) : (
          <>
            <a className="s3d-back" href={window.location.pathname}>← Niche Space Directory</a>
            <h1>Neighbourhood in 3D</h1>
            <p>Drag to turn, scroll or pinch to zoom. Distances are squashed so near and far both fit.</p>
          </>
        )}
        <div className="s3d-filters" role="group" aria-label="Show categories">
          {CATEGORIES.map((c) => (
            <button key={c.id} type="button" className={`s3d-chip s3d-cat-${c.id}`} aria-pressed={shown[c.id]} onClick={() => toggle(c.id)}>
              <i /> {c.label}
            </button>
          ))}
        </div>
      </header>

      <div className="s3d-panel">
        {selected ? (
          <div className="s3d-card">
            <p className={`s3d-kind s3d-cat-${selected.category}`}><i /> {selected.kind}</p>
            <h2>{selected.name}</h2>
            <p className="s3d-dist">{fmtLy(selected.ly)} from the Sun</p>
            <p className="s3d-note">{selected.note}</p>
            <div className="s3d-actions">
              <a
                className="primary"
                href={viewerHref(selected)}
                onClick={onOpen && ((e) => { e.preventDefault(); onOpen(selected); })}
              >
                Open in sky viewer
              </a>
              <button type="button" onClick={() => pick(null)}>Back to the Sun</button>
            </div>
          </div>
        ) : (
          <p className="s3d-hint">{embedded ? "Drag to turn, pinch or scroll to zoom, tap a star to fly there." : "Pick a star on the map or from the list to fly there."}</p>
        )}
        {!embedded && <ul className="s3d-list" aria-label="Objects">
          {visible.map((o) => (
            <li key={o.id}>
              <button type="button" className={`s3d-cat-${o.category}`} aria-current={selected?.id === o.id} onClick={() => pick(o)}>
                <i /> {o.name} <span>{fmtLy(o.ly).replace(" light-years", " ly")}</span>
              </button>
            </li>
          ))}
        </ul>}
      </div>
    </div>
  );
}
