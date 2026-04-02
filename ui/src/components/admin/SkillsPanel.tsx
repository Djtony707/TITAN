import { useEffect, useMemo, useState } from 'react';
import { getSkills } from '@/api/client';
import { PageHeader } from '@/components/shared/PageHeader';
import type { SkillInfo } from '@/api/types';

function SkillsPanel() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>('all');

  useEffect(() => {
    const load = async () => {
      try {
        const data = await getSkills();
        setSkills(data);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to fetch skills');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const categories = useMemo(() => {
    const cats = new Set(skills.map((s) => s.category));
    return ['all', ...Array.from(cats).sort()];
  }, [skills]);

  const filtered = useMemo(() => {
    if (activeCategory === 'all') return skills;
    return skills.filter((s) => s.category === activeCategory);
  }, [skills, activeCategory]);

  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-28 animate-pulse rounded-xl border border-border bg-bg-secondary" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-error/50 bg-bg-secondary p-6 text-center text-error">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Skills" breadcrumbs={[{label:'Admin', href:'/overview'}, {label:'Tools'}, {label:'Skills'}]} />

      {/* Category tabs */}
      <div className="flex flex-wrap gap-2">
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
              activeCategory === cat
                ? 'bg-accent text-white'
                : 'bg-bg-tertiary text-text-secondary hover:text-text'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Skills grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((skill) => (
          <div
            key={skill.name}
            className="rounded-xl border border-border bg-bg-secondary p-4"
          >
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-medium text-text">{skill.name}</h3>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  skill.enabled
                    ? 'bg-success/10 text-success'
                    : 'bg-text-muted/10 text-text-muted'
                }`}
              >
                {skill.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>
            <p className="text-sm text-text-secondary">{skill.description}</p>
            <p className="mt-2 text-xs capitalize text-text-muted">{skill.category}</p>
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="col-span-full py-12 text-center text-text-muted">
            No skills in this category
          </p>
        )}
      </div>
    </div>
  );
}

export default SkillsPanel;
