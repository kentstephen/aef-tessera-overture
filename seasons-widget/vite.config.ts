import { defineConfig } from "vite";

// one ES module for the notebook's anywidget: the worker, the decoder's weights, the model and the styles all inlined
export default defineConfig({
  // a library build leaves these to the app; the notebook has none
  define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
  worker: { format: "es", rollupOptions: { output: { inlineDynamicImports: true } } },
  build: {
    target: "es2022",
    lib: { entry: "src/widget.ts", formats: ["es"], fileName: () => "widget.js" },
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
