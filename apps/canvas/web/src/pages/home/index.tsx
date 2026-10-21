import { useCallback, useEffect, useState } from "react";

import { fetchDramaProjects, type ToivDramaProject } from "@/services/toiv/client";
import { HomeDashboard } from "./home-dashboard";
import "./home-dashboard.css";

export default function HomePage() {
    const [projects, setProjects] = useState<ToivDramaProject[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        setError(false);
        try {
            const rows = await fetchDramaProjects();
            setProjects(rows.slice(0, 8));
        } catch {
            setError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    return <HomeDashboard projects={projects} loading={loading} error={error} onRetry={() => void load()} />;
}
