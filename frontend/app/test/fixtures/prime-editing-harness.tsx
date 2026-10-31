import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import PrimeCreate from "../../src/toiv/pages/PrimeCreate";
import PrimeStoryboard from "../../src/toiv/pages/PrimeStoryboard";
import { I18nProvider } from "../../src/i18n";

createRoot(document.getElementById("root")!).render(
    <I18nProvider>
        <BrowserRouter>
            <Routes>
                <Route path="/create" element={<PrimeCreate />} />
                <Route path="/studio/:id" element={<PrimeStoryboard />} />
            </Routes>
        </BrowserRouter>
    </I18nProvider>,
);
