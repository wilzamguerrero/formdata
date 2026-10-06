import React, { useRef, useState } from "react";
import { Upload, X, File, FileText, ImageIcon, Film, Music, CheckCircle } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface DropzoneProps {
  files: File[];
  onFilesAdded: (newFiles: File[]) => void;
  onFileRemoved: (index: number) => void;
}

export default function Dropzone({ files, onFilesAdded, onFileRemoved }: DropzoneProps) {
  const [isDragActive, setIsDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setIsDragActive(true);
    } else if (e.type === "dragleave") {
      setIsDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const addedFiles = Array.from(e.dataTransfer.files) as File[];
      onFilesAdded(addedFiles);
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const addedFiles = Array.from(e.target.files) as File[];
      onFilesAdded(addedFiles);
    }
  };

  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const getFileIcon = (fileName: string) => {
    const ext = fileName.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "jpg":
      case "jpeg":
      case "png":
      case "gif":
      case "webp":
      case "svg":
        return <ImageIcon className="w-5 h-5 text-emerald-500" />;
      case "mp4":
      case "mov":
      case "avi":
      case "mkv":
        return <Film className="w-5 h-5 text-indigo-500" />;
      case "mp3":
      case "wav":
      case "ogg":
      case "flac":
        return <Music className="w-5 h-5 text-pink-500" />;
      case "pdf":
      case "doc":
      case "docx":
      case "xls":
      case "xlsx":
      case "ppt":
      case "pptx":
      case "txt":
      case "csv":
        return <FileText className="w-5 h-5 text-amber-500" />;
      default:
        return <File className="w-5 h-5 text-slate-400" />;
    }
  };

  return (
    <div className="w-full">
      <div
        id="file-dropzone-container"
        onDragEnter={handleDrag}
        onDragOver={handleDrag}
        onDragLeave={handleDrag}
        onDrop={handleDrop}
        onClick={triggerFileInput}
        className={`relative border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all duration-300 flex flex-col items-center justify-center gap-4 ${
          isDragActive
            ? "border-white bg-white/[0.06] scale-[1.01]"
            : "border-white/10 hover:border-white/25 bg-white/[0.01] hover:bg-white/[0.03]"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileInput}
        />

        <div className="p-4 bg-white/5 rounded-2xl text-white transition-transform duration-300">
          <Upload className="w-10 h-10" />
        </div>

        <div>
          <h3 className="text-base font-semibold text-white">
            Arrastra tus archivos aquí o haz clic
          </h3>
          <p className="text-xs text-white/40 mt-1">
            Cualquier tipo de archivo (Máx. 5GB por archivo)
          </p>
        </div>
      </div>

      {files.length > 0 && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-white/40 uppercase tracking-wider">
              Archivos en cola ({files.length})
            </span>
            <span className="text-xs text-white/30 font-mono">
              Total: {formatSize(files.reduce((acc, f) => acc + f.size, 0))}
            </span>
          </div>

          <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
            <AnimatePresence initial={false}>
              {files.map((file, idx) => (
                <motion.div
                  key={`${file.name}-${idx}`}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -10 }}
                  transition={{ duration: 0.2 }}
                  className="flex items-center justify-between bg-[#111111] border border-white/10 p-3 rounded-xl shadow-xs hover:border-white/20 group"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="p-2 bg-white/5 rounded-lg shrink-0">
                      {getFileIcon(file.name)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-slate-200 truncate">
                        {file.name}
                      </p>
                      <p className="text-xs text-white/40 font-mono">
                        {formatSize(file.size)}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onFileRemoved(idx);
                    }}
                    className="p-1 px-1.5 rounded-lg text-white/40 hover:bg-red-500/10 hover:text-red-400 transition-colors shrink-0 md:opacity-0 group-hover:opacity-100"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>
      )}
    </div>
  );
}
