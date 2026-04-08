import { useEffect, useMemo, useState, useCallback } from 'react';
import { Search, Download, Trash2, Package, Store } from 'lucide-react';
import { getSkills, apiFetch } from '@/api/client';
import { PageHeader } from '@/components/shared/PageHeader';
import type { SkillInfo } from '@/api/types';

interface MarketplaceSkill {
  name: string;
  description: string;
  file: string;
  category?: string;
  tags?: string[];
  author?: string;
  installed: boolean;
}

function SkillsPanel() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [marketplace, setMarketplace] = useState<MarketplaceSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [activeTab, setActiveTab] = useState<'installed' | 'marketplace'>('installed');
  const [search, setSearch] = useState('');
  const [installing, setInstalling] = useState<string | null>(null);

  const loadSkills = useCallback(async () => {
    try {
      const data = await getSkills();
      setSkills(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch skills');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMarketplace = useCallback(async () => {
    try {
      const res = await apiFetch('/api/marketplace');
      if (res.ok) {
        const data = await res.json();
        setMarketplace(data.skills || []);
      }
    } catch { /* marketplace unavailable */ }
  }, []);

  useEffect(() => {
    loadSkills();
    loadMarketplace();
  }, [loadSkills, loadMarketplace]);

  const handleInstall = async (skillName: string) => {
    setInstalling(skillName);
    try {
      const res = await apiFetch('/api/marketplace/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: skillName }),
      });
      if (res.ok) {
        loadSkills();
        loadMarketplace();
      }
    } finally {
      setInstalling(null);
    }
  };

  const handleUninstall = async (skillName: string) => {
    if (!confirm(`Uninstall skill "${skillName}"?`)) return;
    try {
      await apiFetch('/api/marketplace/uninstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: skillName }),
      });
      loadSkills();
      loadMarketplace();
    } catch { /* ignore */ }
  };

  const categories = useMemo(() => {
    const source = activeTab === 'installed' ? skills : marketplace;
    const cats = new Set(source.map((s) => ('category' in s ? s.category : '') || 'other'));
    return ['all', ...Array.from(cats).sort()];
  }, [skills, marketplace, activeTab]);

  const filteredInstalled = useMemo(() => {
    let list = skills;
    if (activeCategory !== 'all') list = list.filter((s) => s.category === activeCategory);
    if (search) list = list.filter((s) => s.name.toLowerCase().includes(search.toLowerCase()) || s.description?.toLowerCase().includes(search.toLowerCase()));
    return list;
  }, [skills, activeCategory, search]);

  const filteredMarketplace = useMemo(() => {
    let list = marketplace;
    if (activeCategory !== 'all') list = list.filter((s) => (s.category || 'other') === activeCategory);
    if (search) list = list.filter((s) => s.name.toLowerCase().includes(search.toLowerCase()) || s.description?.toLowerCase().includes(search.toLowerCase()));
    return list;
  }, [marketplace, activeCategory, search]);

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
      <PageHeader title="Skills" breadcrumbs={[{ label: 'Admin', href: '/overview' }, { label: 'Tools' }, { label: 'Skills' }]} />

      {/* Tab switcher */}
      <div className="flex items-center gap-4 border-b border-border pb-2">
        <button
          onClick={() => { setActiveTab('installed'); setActiveCategory('all'); }}
          className={`flex items-center gap-1.5 pb-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'installed' ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text'
          }`}
        >
          <Package className="h-4 w-4" /> Installed ({skills.length})
        </button>
        <button
          onClick={() => { setActiveTab('marketplace'); setActiveCategory('all'); }}
          className={`flex items-center gap-1.5 pb-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'marketplace' ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text'
          }`}
        >
          <Store className="h-4 w-4" /> Marketplace ({marketplace.length})
        </button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-muted" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Search ${activeTab === 'installed' ? 'installed skills' : 'marketplace'}...`}
          className="w-full rounded-lg border border-border bg-bg-secondary py-2 pl-9 pr-4 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
      </div>

      {/* Category tabs */}
      <div className="flex flex-wrap gap-2">
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
              activeCategory === cat
                ? 'bg-accent text-white'
                : 'bg-bg-tertiary text-text-secondary hover:text-text'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Content */}
      {activeTab === 'installed' ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filteredInstalled.map((skill) => (
            <div key={skill.name} className="rounded-xl border border-border bg-bg-secondary p-4">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-medium text-text text-sm">{skill.name}</h3>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  skill.enabled ? 'bg-success/10 text-success' : 'bg-text-muted/10 text-text-muted'
                }`}>
                  {skill.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
              <p className="text-xs text-text-secondary line-clamp-2">{skill.description}</p>
              <div className="mt-2 flex items-center justify-between">
                <span className="text-[10px] capitalize text-text-muted">{skill.category}</span>
                {marketplace.some(m => m.name === skill.name && m.installed) && (
                  <button
                    onClick={() => handleUninstall(skill.name)}
                    className="text-[10px] text-error hover:underline flex items-center gap-1"
                  >
                    <Trash2 className="h-3 w-3" /> Uninstall
                  </button>
                )}
              </div>
            </div>
          ))}
          {filteredInstalled.length === 0 && (
            <p className="col-span-full py-12 text-center text-text-muted">No skills match your search</p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filteredMarketplace.map((skill) => (
            <div key={skill.name} className={`rounded-xl border bg-bg-secondary p-4 ${skill.installed ? 'border-success/30' : 'border-border'}`}>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-medium text-text text-sm">{skill.name}</h3>
                {skill.installed ? (
                  <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">Installed</span>
                ) : (
                  <button
                    onClick={() => handleInstall(skill.name)}
                    disabled={installing === skill.name}
                    className="flex items-center gap-1 rounded-md bg-accent/10 px-2 py-1 text-[10px] font-medium text-accent hover:bg-accent/20 disabled:opacity-50 transition-colors"
                  >
                    <Download className="h-3 w-3" />
                    {installing === skill.name ? 'Installing...' : 'Install'}
                  </button>
                )}
              </div>
              <p className="text-xs text-text-secondary line-clamp-2">{skill.description}</p>
              <div className="mt-2 flex items-center gap-2">
                <span className="text-[10px] capitalize text-text-muted">{skill.category || 'other'}</span>
                {skill.author && <span className="text-[10px] text-text-muted">by {skill.author}</span>}
                {skill.tags?.slice(0, 3).map(t => (
                  <span key={t} className="rounded bg-bg-tertiary px-1.5 py-0.5 text-[9px] text-text-muted">{t}</span>
                ))}
              </div>
            </div>
          ))}
          {filteredMarketplace.length === 0 && (
            <p className="col-span-full py-12 text-center text-text-muted">
              {marketplace.length === 0 ? 'Marketplace unavailable — check network connection' : 'No skills match your search'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default SkillsPanel;
