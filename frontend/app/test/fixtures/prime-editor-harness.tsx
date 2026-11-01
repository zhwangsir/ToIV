import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import PrimeEditor from "../../src/toiv/pages/PrimeEditor";
import { I18nProvider } from "../../src/i18n";

createRoot(document.getElementById("root")!).render(
    <I18nProvider>
        <BrowserRouter>
            <Routes>
                <Route path="/studio/:id/editor" element={<PrimeEditor />} />
                <Route path="/studio/:id" element={<p>流水线占位</p>} />
                <Route path="/studio" element={<p>项目库占位</p>} />
                <Route path="/tasks" element={<p>任务占位</p>} />
                <Route path="/drama" element={<p>画布占位</p>} />
            </Routes>
        </BrowserRouter>
    </I18nProvider>,
);
