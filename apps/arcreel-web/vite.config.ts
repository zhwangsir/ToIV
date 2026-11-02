import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// ToIV apps/arcreel-web — ArcReel FE sub-app.
// Built assets served under Prime at /arcreel/; vite dev stays at /.
// No Ant Design rewrite this wave. No cross-import freezone/canvas.
export default defineConfig(({ command }) => {
    const base = command === "build" ? "/arcreel/" : "/";
    return {
        base,
        plugins: [react(), tailwindcss()],
        resolve: {
            alias: { "@": path.resolve(__dirname, "src") },
            extensions: [".mjs", ".mts", ".ts", ".tsx", ".js", ".jsx", ".json"],
        },
        server: {
            host: "0.0.0.0",
            port: 5175,
            strictPort: true,
            proxy: {
                // BE not wired this wave — leave proxy for local optional server; UI must fail honestly if down.
                "/api": {
                    target: "http://127.0.0.1:1241",
                    changeOrigin: true,
                },
                "/mcp": {
                    target: "http://127.0.0.1:1241",
                    changeOrigin: true,
                },
            },
        },
        preview: {
            host: true,
            port: 4175,
            strictPort: true,
        },
        build: {
            outDir: "dist",
            emptyOutDir: true,
        },
    };
});
