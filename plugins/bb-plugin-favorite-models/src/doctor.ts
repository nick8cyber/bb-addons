import { labelKey, normalizeModelKey, type FavoritesSnapshot, type ProviderIdentity } from "./store.js";

export function inspectFavorites(snapshot: FavoritesSnapshot, providers: readonly ProviderIdentity[]) {
  const providerIds = new Set(providers.map(({ id }) => id));
  const findings: string[] = [];
  const favorites: FavoritesSnapshot["favorites"] = {};
  const modelLabels = { ...snapshot.modelLabels };
  const ambiguous = new Set<string>();

  for (const [provider, models] of Object.entries(snapshot.favorites)) {
    if (!providerIds.has(provider)) {
      findings.push(`Unknown provider ${provider} (${models.length} favorites): remove its group`);
      continue;
    }

    // A label can provide route evidence even when its old key was bare,
    // or when the label was written alongside an already routed key.
    const routes = new Map<string, Set<string>>();
    const prefix = `${provider}:`;
    for (const [key, label] of Object.entries(snapshot.modelLabels)) {
      if (!key.startsWith(prefix)) continue;
      const model = key.slice(prefix.length).split(" · ")[0];
      for (const text of [key.slice(prefix.length), normalizeModelKey(label)]) {
        if (!text.startsWith(`${model} · `)) continue;
        const candidates = routes.get(model) ?? new Set<string>();
        candidates.add(text);
        routes.set(model, candidates);
      }
    }

    favorites[provider] = [...new Set(models.map((model) => {
      if (model.includes(" · ")) return model;
      const candidates = routes.get(model);
      if (!candidates?.size) return model;
      if (candidates.size > 1) {
        ambiguous.add(labelKey(provider, model));
        findings.push(`Route ambiguous for ${provider}:${model} (${[...candidates].join(", ")}): left unchanged`);
        return model;
      }
      const [routed] = candidates;
      findings.push(`Missing route for ${provider}:${model}: use ${routed}`);
      const oldLabel = modelLabels[labelKey(provider, model)];
      modelLabels[labelKey(provider, routed)] ??= oldLabel?.includes(" · ") ? oldLabel : routed;
      delete modelLabels[labelKey(provider, model)];
      return routed;
    }))];
  }

  for (const key of Object.keys(snapshot.modelLabels)) {
    const idx = key.indexOf(":");
    const provider = key.slice(0, idx);
    const model = key.slice(idx + 1);
    if (idx > 0 && provider !== "default" && favorites[provider]?.includes(model)) continue;
    if (ambiguous.has(labelKey(provider, model.split(" · ")[0]))) continue;
    // The route move already reports its old label.
    if (!Object.hasOwn(modelLabels, key)) continue;
    findings.push(`${provider === "default" ? "Default" : "Orphan"} label ${key}: remove`);
    delete modelLabels[key];
  }

  return { findings, favorites, modelLabels };
}
