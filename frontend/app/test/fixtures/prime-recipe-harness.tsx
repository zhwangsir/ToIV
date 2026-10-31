import { createRoot } from "react-dom/client";
import { useState } from "react";
import { I18nProvider } from "../../src/i18n";
import { PrimeImportDialog } from "../../src/toiv/addons/RecipePanelPrime";

function Harness() {
    const [open, setOpen] = useState(false);
    return <I18nProvider>
        <button onClick={() => setOpen(true)}>打开安装</button>
        <PrimeImportDialog open={open} onClose={() => setOpen(false)} onInstall={async payload => {
            const response = await fetch("/install", { method: "POST", body: JSON.stringify(payload) });
            if (!response.ok) throw new Error("安装服务暂不可用");
            setOpen(false);
        }} />
    </I18nProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
