import React, { useState, useEffect } from "react";
import {
  User, Mail, CreditCard, Phone, GraduationCap, Send, CheckCircle2,
  Loader2, ArrowLeft, UploadCloud, AlertTriangle, ExternalLink, Calendar,
} from "lucide-react";
import { uploadFiles, type UploadRecord } from "./uploadService";
import Dropzone from "./components/Dropzone";
import { motion, AnimatePresence } from "motion/react";

/* ──────────────────────────────────────────────────────────────────────────
   Sistema de preinscripción y recepción de material (estudiantes, profesionales
   y egresados). Recepciona directo en Notion usando un motor con cola para no
   saturar la API (semáforo en el servidor + subida adaptativa en el cliente).

   Las CATEGORÍAS son los proyectos de la página de Notion configurada. Para
   "agregar más", crea otro proyecto/carpeta en Notion y aparecerá aquí como un
   botón cuadrado nuevo automáticamente.
   ────────────────────────────────────────────────────────────────────────── */

interface Project {
  id: string;
  name: string;
  isActive?: boolean;
}

interface CategoryStructure {
  useHierarchy: boolean;
  hasDirectDest: boolean;
  years: string[];
  periodsByYear: Record<string, string[]>;
}

/** Enlace a tu página de Notion para que las personas revisen lo que enviaron.
 *  Déjalo vacío para ocultar el botón. */
const NOTION_PUBLIC_URL = "";

const initialsOf = (name: string): string => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
};

const CATEGORY_COLORS = [
  "#8b5cf6", "#f43f5e", "#06b6d4", "#f97316", "#22c55e",
  "#a855f7", "#ef4444", "#14b8a6", "#eab308", "#3b82f6",
];
const colorFor = (i: number) => CATEGORY_COLORS[i % CATEGORY_COLORS.length];

type View = "home" | "scope" | "menu" | "preinscripcion" | "material";

interface SuccessInfo {
  kind: "preinscripcion" | "material";
  name: string;
  projectName: string;
  files?: number;
}

export default function App() {
  const [bootDone, setBootDone] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [view, setView] = useState<View>("home");
  const [category, setCategory] = useState<Project | null>(null);

  // Estructura (año/periodo) de la categoría seleccionada.
  const [structure, setStructure] = useState<CategoryStructure | null>(null);
  const [loadingStructure, setLoadingStructure] = useState(false);
  const [year, setYear] = useState("");
  const [period, setPeriod] = useState("");

  const [preName, setPreName] = useState("");
  const [preDoc, setPreDoc] = useState("");
  const [preEmail, setPreEmail] = useState("");
  const [prePhone, setPrePhone] = useState("");
  const [preProgram, setPreProgram] = useState("");
  const [preNote, setPreNote] = useState("");

  const [matName, setMatName] = useState("");
  const [matEmail, setMatEmail] = useState("");
  const [matDoc, setMatDoc] = useState("");
  const [matComment, setMatComment] = useState("");
  const [matFiles, setMatFiles] = useState<File[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [step, setStep] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SuccessInfo | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/projects");
        const data = await res.json();
        if (data.success) {
          setProjects((data.projects || []).filter((p: Project) => p.isActive !== false));
        } else {
          setLoadError(data.error || "No se pudieron cargar las categorías.");
        }
      } catch {
        setLoadError("Error de red al cargar las categorías.");
      } finally {
        setBootDone(true);
      }
    })();
  }, []);

  const resetForms = () => {
    setPreName(""); setPreDoc(""); setPreEmail(""); setPrePhone(""); setPreProgram(""); setPreNote("");
    setMatName(""); setMatEmail(""); setMatDoc(""); setMatComment(""); setMatFiles([]);
    setError(null); setStep(""); setProgress(null);
  };

  const goHome = () => { setView("home"); setCategory(null); setStructure(null); setYear(""); setPeriod(""); setSuccess(null); resetForms(); };

  const openCategory = async (p: Project) => {
    setCategory(p); setSuccess(null); resetForms();
    setYear(""); setPeriod(""); setStructure(null);
    setLoadingStructure(true);
    setView("scope");
    try {
      const res = await fetch(`/api/category-structure?categoryId=${encodeURIComponent(p.id)}`);
      const data = await res.json();
      const st: CategoryStructure = data.success ? data.structure : { useHierarchy: false, hasDirectDest: true, years: [], periodsByYear: {} };
      setStructure(st);
      if (!st.useHierarchy) {
        // Sin año/periodo → directo al menú.
        setView("menu");
      } else {
        // Preselecciona si hay un único año; si además ese año no tiene periodos,
        // salta directo al menú (no hay nada que preguntar).
        if (st.years.length === 1) {
          const onlyYear = st.years[0];
          setYear(onlyYear);
          const periods = st.periodsByYear[onlyYear] || [];
          if (periods.length === 0) setView("menu");
        }
      }
    } catch {
      setStructure({ useHierarchy: false, hasDirectDest: true, years: [], periodsByYear: {} });
      setView("menu");
    } finally {
      setLoadingStructure(false);
    }
  };

  // Cuando ya hay año+periodo resueltos (o la categoría no los usa), ir al menú.
  const confirmScope = () => { setView("menu"); setSuccess(null); };
  const backToMenu = () => { setView("menu"); setSuccess(null); resetForms(); };

  const submitPreinscripcion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!category) return;
    if (!preName.trim() || !preEmail.trim() || !preDoc.trim()) {
      setError("Completa al menos nombre, documento y correo.");
      return;
    }
    setSubmitting(true); setError(null); setProgress(null);
    const detalle = [
      `Tipo: Preinscripción`,
      `Categoría: ${category.name}`,
      `Nombre: ${preName.trim()}`,
      `Documento: ${preDoc.trim()}`,
      `Correo: ${preEmail.trim()}`,
      prePhone.trim() ? `Teléfono: ${prePhone.trim()}` : "",
      preProgram.trim() ? `Programa / Carrera: ${preProgram.trim()}` : "",
      preNote.trim() ? `Observaciones: ${preNote.trim()}` : "",
    ].filter(Boolean).join("\n");
    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          senderName: preName.trim(),
          senderEmail: preEmail.trim(),
          projectId: category.id,
          projectName: category.name,
          fileRecords: [],
          comment: detalle,
          document: preDoc.trim(),
          dest: "1REGISTRO",
          year, period,
          program: preProgram.trim(),
          accentColor: accent,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setSuccess({ kind: "preinscripcion", name: preName.trim(), projectName: category.name });
        resetForms();
      } else {
        setError(data.error || "No se pudo registrar la preinscripción.");
      }
    } catch {
      setError("Error de conexión con el servidor.");
    } finally {
      setSubmitting(false); setStep(""); setProgress(null);
    }
  };

  const submitMaterial = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!category) return;
    if (!matName.trim() || !matEmail.trim() || !matDoc.trim()) {
      setError("Completa tu nombre, documento y correo.");
      return;
    }
    if (matFiles.length === 0 && !matComment.trim()) {
      setError("Adjunta al menos un archivo o escribe un comentario / enlace.");
      return;
    }
    setSubmitting(true); setError(null); setProgress(null);

    let fileRecords: UploadRecord[] = [];
    if (matFiles.length > 0) {
      try {
        fileRecords = await uploadFiles(matFiles, {
          onStep: (s) => setStep(s),
          onProgress: (p) => setProgress(p),
        });
      } catch (err: any) {
        setError(err?.message || "Error al subir archivos.");
        setSubmitting(false); setStep(""); setProgress(null);
        return;
      }
    }

    setProgress(100);
    const comment = [
      `Tipo: Material del proyecto preinscrito`,
      matComment.trim() ? `\n${matComment.trim()}` : "",
    ].join("");
    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          senderName: matName.trim(),
          senderEmail: matEmail.trim(),
          projectId: category.id,
          projectName: category.name,
          fileRecords,
          comment,
          document: matDoc.trim(),
          dest: "2DATA",
          year, period,
          accentColor: accent,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setSuccess({ kind: "material", name: matName.trim(), projectName: category.name, files: fileRecords.length });
        resetForms();
      } else {
        setError(data.error || "No se pudo registrar el material.");
      }
    } catch {
      setError("Error de conexión con el servidor.");
    } finally {
      setSubmitting(false); setStep(""); setProgress(null);
    }
  };

  const accent = category ? colorFor(projects.findIndex((p) => p.id === category.id)) : "#4f46e5";

  return (
    <>
      {/* Fondo dinámico suave */}
      <div
        className="upz-bg"
        style={{
          "--upz-c1": accent,
          "--upz-c2": CATEGORY_COLORS[1],
          "--upz-c3": CATEGORY_COLORS[2],
        } as React.CSSProperties}
      >
        <div className="upz-blob upz-blob-1" />
        <div className="upz-blob upz-blob-2" />
        <div className="upz-blob upz-blob-3" />
      </div>

      <div className={`relative z-[1] min-h-screen flex flex-col text-white antialiased transition-opacity duration-500 ${bootDone ? "opacity-100" : "opacity-0"}`}>
        <main className="flex-1 w-full max-w-5xl mx-auto px-5 sm:px-8 py-10 flex flex-col justify-center">
          <AnimatePresence mode="wait">

            {view === "home" && (
              <motion.div key="home" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -16 }} transition={{ duration: 0.3 }} className="text-center">
                {loadError ? (
                  <div className="max-w-md mx-auto p-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 text-amber-200 text-sm flex items-start gap-2">
                    <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
                    <span>{loadError}</span>
                  </div>
                ) : projects.length === 0 ? (
                  <div className="max-w-md mx-auto p-6 rounded-2xl border border-white/10 bg-white/5 text-white/60 text-sm">
                    Aún no hay categorías. Crea proyectos en tu página de Notion y aparecerán aquí.
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-4 sm:gap-5 max-w-sm mx-auto">
                    {projects.map((p, i) => (
                      <motion.button
                        key={p.id}
                        type="button"
                        onClick={() => openCategory(p)}
                        className="upz-square"
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: 0.05 * i, duration: 0.3 }}
                      >
                        <span className="upz-initials" style={{ color: colorFor(i) }}>{initialsOf(p.name)}</span>
                        <span className="upz-square-label">{p.name}</span>
                      </motion.button>
                    ))}
                  </div>
                )}

                {NOTION_PUBLIC_URL && (
                  <a href={NOTION_PUBLIC_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 mt-10 text-xs text-white/50 hover:text-white transition-colors">
                    <ExternalLink className="w-3.5 h-3.5" /> Revisar lo enviado en Notion
                  </a>
                )}
              </motion.div>
            )}

            {view === "scope" && category && (
              <motion.div key="scope" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -16 }} transition={{ duration: 0.3 }} className="max-w-xl mx-auto w-full">
                <BackBtn onClick={goHome} label="Categorías" />
                <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mt-4 mb-1" style={{ color: accent }}>{category.name}</h2>
                <p className="text-sm text-white/60 mb-8">Selecciona el año y el periodo.</p>
                {loadingStructure || !structure ? (
                  <div className="flex items-center gap-2 text-white/50 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Cargando…</div>
                ) : (
                  <ScopePicker
                    structure={structure}
                    accent={accent}
                    year={year} period={period}
                    onYear={(y) => { setYear(y); setPeriod(""); }}
                    onPeriod={setPeriod}
                    onConfirm={confirmScope}
                  />
                )}
              </motion.div>
            )}

            {view === "menu" && category && (
              <motion.div key="menu" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -16 }} transition={{ duration: 0.3 }} className="max-w-2xl mx-auto w-full">
                <BackBtn onClick={() => (structure?.useHierarchy ? setView("scope") : goHome())} label={structure?.useHierarchy ? "Año / Periodo" : "Categorías"} />
                <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mt-4 mb-1" style={{ color: accent }}>{category.name}</h2>
                <p className="text-sm text-white/60 mb-8">
                  {year ? <>Año <strong className="text-white/80">{year}</strong>{period ? <> · Periodo <strong className="text-white/80">{period}</strong></> : null} · ¿Qué deseas hacer?</> : "¿Qué deseas hacer?"}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                  <ActionCard icon={<GraduationCap className="w-8 h-8" />} title="Preinscripción" desc="Registra tus datos para preinscribirte en este evento." accent={accent} onClick={() => { setView("preinscripcion"); setSuccess(null); }} />
                  <ActionCard icon={<UploadCloud className="w-8 h-8" />} title="Cargar material" desc="Envía los archivos del proyecto que preinscribiste." accent={accent} onClick={() => { setView("material"); setSuccess(null); }} />
                </div>
              </motion.div>
            )}

            {view === "preinscripcion" && category && (
              <motion.div key="pre" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -16 }} transition={{ duration: 0.3 }} className="max-w-xl mx-auto w-full">
                <BackBtn onClick={backToMenu} label={category.name} />
                {success?.kind === "preinscripcion" ? (
                  <SuccessView accent={accent} title="¡Preinscripción registrada!" lines={[success.name, `Categoría: ${success.projectName}`]} onAgain={() => setSuccess(null)} onHome={goHome} />
                ) : (
                  <form onSubmit={submitPreinscripcion} className="mt-4 space-y-5">
                    <Header icon={<GraduationCap />} accent={accent} title="Preinscripción" sub={category.name} />
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <Field label="Nombre completo" icon={<User />} value={preName} onChange={setPreName} required />
                      <Field label="Documento de identidad" icon={<CreditCard />} value={preDoc} onChange={setPreDoc} required />
                      <Field label="Correo" icon={<Mail />} type="email" value={preEmail} onChange={setPreEmail} required />
                      <Field label="Teléfono (opcional)" icon={<Phone />} type="tel" value={prePhone} onChange={setPrePhone} />
                    </div>
                    <Field label="Programa / Carrera (opcional)" icon={<GraduationCap />} value={preProgram} onChange={setPreProgram} />
                    <TextArea label="Observaciones (opcional)" value={preNote} onChange={setPreNote} />
                    {error && <ErrorBox msg={error} />}
                    <SubmitBtn accent={accent} submitting={submitting} progress={progress} step={step} label="Enviar preinscripción" icon={<Send className="w-4 h-4" />} />
                  </form>
                )}
              </motion.div>
            )}

            {view === "material" && category && (
              <motion.div key="mat" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -16 }} transition={{ duration: 0.3 }} className="max-w-xl mx-auto w-full">
                <BackBtn onClick={backToMenu} label={category.name} />
                {success?.kind === "material" ? (
                  <SuccessView accent={accent} title="¡Material enviado!" lines={[success.name, `Categoría: ${success.projectName}`, `Archivos: ${success.files}`]} onAgain={() => setSuccess(null)} onHome={goHome} />
                ) : (
                  <form onSubmit={submitMaterial} className="mt-4 space-y-5">
                    <Header icon={<UploadCloud />} accent={accent} title="Cargar material" sub={category.name} />
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <Field label="Nombre completo" icon={<User />} value={matName} onChange={setMatName} required />
                      <Field label="Documento" icon={<CreditCard />} value={matDoc} onChange={setMatDoc} required />
                    </div>
                    <Field label="Correo" icon={<Mail />} type="email" value={matEmail} onChange={setMatEmail} required />
                    <TextArea label="Comentario / enlace (opcional)" value={matComment} onChange={setMatComment} />
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-white/50 uppercase tracking-wide">Archivos</label>
                      <Dropzone files={matFiles} onFilesAdded={(f) => setMatFiles((p) => [...p, ...f])} onFileRemoved={(i) => setMatFiles((p) => p.filter((_, idx) => idx !== i))} />
                    </div>
                    {error && <ErrorBox msg={error} />}
                    <SubmitBtn accent={accent} submitting={submitting} progress={progress} step={step} label="Enviar material" icon={<UploadCloud className="w-4 h-4" />} />
                  </form>
                )}
              </motion.div>
            )}

          </AnimatePresence>
        </main>

        <footer className="text-center py-4 text-[10px] text-white/25 font-mono tracking-wide">
          Universidad de Nariño / Inscripción / Material
        </footer>
      </div>
    </>
  );
}

/* ──────────────────────────── Subcomponentes ──────────────────────────── */

function BackBtn({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1.5 text-xs font-semibold text-white/50 hover:text-white transition-colors">
      <ArrowLeft className="w-4 h-4" /> {label}
    </button>
  );
}

function ActionCard({ icon, title, desc, accent, onClick }: { icon: React.ReactNode; title: string; desc: string; accent: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="group text-left p-6 rounded-3xl border border-white/12 bg-white/[0.05] hover:bg-white/[0.09] hover:border-white/30 backdrop-blur-md transition-all duration-300 hover:-translate-y-1">
      <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4 transition-transform group-hover:scale-110" style={{ backgroundColor: `${accent}22`, color: accent }}>{icon}</div>
      <h3 className="text-lg font-bold mb-1">{title}</h3>
      <p className="text-xs text-white/55 leading-relaxed">{desc}</p>
    </button>
  );
}

function Header({ icon, title, sub, accent }: { icon: React.ReactNode; title: string; sub: string; accent: string }) {
  return (
    <div className="flex items-center gap-3 pb-2">
      <div className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 [&>svg]:w-5 [&>svg]:h-5" style={{ backgroundColor: `${accent}22`, color: accent }}>{icon}</div>
      <div>
        <h2 className="text-xl font-bold leading-tight">{title}</h2>
        <p className="text-xs text-white/50">{sub}</p>
      </div>
    </div>
  );
}

function Field({ label, icon, value, onChange, type = "text", required = false }: {
  label: string; icon: React.ReactNode; value: string; onChange: (v: string) => void; type?: string; required?: boolean;
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-white/50 mb-1.5 uppercase tracking-wide">{label}</label>
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 [&>svg]:w-4 [&>svg]:h-4">{icon}</span>
        <input type={type} required={required} value={value} onChange={(e) => onChange(e.target.value)}
          className="w-full pl-10 pr-3 py-2.5 bg-white/[0.05] border border-white/12 rounded-xl text-sm text-white placeholder-white/25 focus:border-white/35 focus:outline-none transition-all" />
      </div>
    </div>
  );
}

function TextArea({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-semibold text-white/50 uppercase tracking-wide">{label}</label>
      <textarea rows={3} value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full px-3.5 py-3 bg-white/[0.05] border border-white/12 rounded-2xl text-sm text-white placeholder-white/25 focus:border-white/35 focus:outline-none transition-all resize-y" />
    </div>
  );
}

function ErrorBox({ msg }: { msg: string }) {
  return (
    <div className="p-3 border border-red-500/40 bg-red-500/10 text-red-200 text-xs rounded-xl flex items-center gap-1.5">
      <AlertTriangle className="w-4 h-4 shrink-0" /> <span>{msg}</span>
    </div>
  );
}

function SubmitBtn({ accent, submitting, progress, step, label, icon }: {
  accent: string; submitting: boolean; progress: number | null; step: string; label: string; icon: React.ReactNode;
}) {
  return (
    <button type="submit" disabled={submitting}
      className="w-full h-[54px] rounded-xl font-semibold text-sm flex items-center justify-center gap-2.5 transition-all duration-300 disabled:opacity-80 text-white"
      style={{ backgroundColor: accent, boxShadow: `0 14px 40px -18px ${accent}` }}>
      {submitting && progress !== null ? (
        <span className="font-mono text-2xl tabular-nums">{progress}%</span>
      ) : submitting ? (
        <span className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />{step || "Enviando..."}</span>
      ) : (
        <>{icon}{label}</>
      )}
    </button>
  );
}

function SuccessView({ accent, title, lines, onAgain, onHome }: {
  accent: string; title: string; lines: string[]; onAgain: () => void; onHome: () => void;
}) {
  return (
    <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="text-center py-10 space-y-6">
      <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto" style={{ backgroundColor: `${accent}22`, color: accent }}>
        <CheckCircle2 className="w-10 h-10" />
      </div>
      <div>
        <h2 className="text-2xl font-bold">{title}</h2>
        <div className="mt-3 text-sm text-white/60 space-y-0.5">{lines.map((l, i) => <p key={i}>{l}</p>)}</div>
      </div>
      <div className="flex items-center justify-center gap-3">
        <button type="button" onClick={onAgain} className="px-5 h-11 rounded-xl text-sm font-semibold text-white border border-white/15 hover:bg-white/10 transition-colors">Enviar otra</button>
        <button type="button" onClick={onHome} className="px-5 h-11 rounded-xl text-sm font-semibold text-white" style={{ backgroundColor: accent }}>Inicio</button>
      </div>
    </motion.div>
  );
}

function ScopePicker({ structure, accent, year, period, onYear, onPeriod, onConfirm }: {
  structure: CategoryStructure; accent: string; year: string; period: string;
  onYear: (y: string) => void; onPeriod: (p: string) => void; onConfirm: () => void;
}) {
  const periods = year ? (structure.periodsByYear[year] || []) : [];
  const needsPeriod = periods.length > 0;
  const ready = !!year && (!needsPeriod || !!period);

  return (
    <div className="space-y-6">
      <div>
        <label className="block text-xs font-semibold text-white/50 mb-2.5 uppercase tracking-wide flex items-center gap-1.5">
          <Calendar className="w-3.5 h-3.5" /> Año
        </label>
        <div className="flex flex-wrap gap-2.5">
          {structure.years.map((y) => (
            <Chip key={y} label={y} active={year === y} accent={accent} onClick={() => onYear(y)} />
          ))}
        </div>
      </div>

      {needsPeriod && (
        <div>
          <label className="block text-xs font-semibold text-white/50 mb-2.5 uppercase tracking-wide">Periodo</label>
          <div className="flex flex-wrap gap-2.5">
            {periods.map((p) => (
              <Chip key={p} label={p} active={period === p} accent={accent} onClick={() => onPeriod(p)} />
            ))}
          </div>
        </div>
      )}

      <button type="button" disabled={!ready} onClick={onConfirm}
        className="w-full h-[52px] rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-all duration-300 disabled:opacity-40 text-white"
        style={{ backgroundColor: accent, boxShadow: `0 14px 40px -18px ${accent}` }}>
        Continuar
      </button>
    </div>
  );
}

function Chip({ label, active, accent, onClick }: { label: string; active: boolean; accent: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="px-5 h-11 rounded-xl text-sm font-bold border transition-all duration-200"
      style={active
        ? { backgroundColor: accent, borderColor: accent, color: "#fff", boxShadow: `0 10px 30px -14px ${accent}` }
        : { backgroundColor: "rgba(255,255,255,0.05)", borderColor: "rgba(255,255,255,0.14)", color: "rgba(255,255,255,0.8)" }}>
      {label}
    </button>
  );
}
