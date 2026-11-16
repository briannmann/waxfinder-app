"""Train the energy model from your Low / Mid / Peak tags (AudioIntel venv: needs scikit-learn).
stdin: {"rows": [{"id", "label": 1|2|3, "x": [...], "bpm", "old"}], "mean": [...], "std": [...], "names": [...]}
stdout: one JSON line - the model (linear SVM, as in the patent) plus leave-one-out accuracy vs the old score.
Each row's "y" is the tag on the 1-10 scale; "agree" = within one of the 5 steps (Low .. Peak), "mae" = mean 1-10 error."""
import json, sys
import numpy as np
from sklearn.svm import LinearSVR

TARGET = {1: 2.0, 2: 3.75, 3: 5.5, 4: 7.25, 5: 9.0}   # Low, Low-mid, Mid, High-mid, Peak
def bucket(s): return np.digitize(s, [2.875, 4.625, 6.375, 8.125]) + 1
def close(p, lab): return float((np.abs(bucket(p) - lab) <= 1).mean())   # within one step
def spearman(a, b):
    ra, rb = np.argsort(np.argsort(a)), np.argsort(np.argsort(b))
    return float(np.corrcoef(ra, rb)[0, 1]) if len(a) > 2 else 0.0

d = json.load(sys.stdin)
rows = d["rows"]; mean, std = np.array(d["mean"]), np.array(d["std"])
X = (np.array([r["x"] for r in rows]) - mean) / std
y = np.array([r["y"] if "y" in r else TARGET[r["label"]] for r in rows], float); lab = bucket(y)   # y = the tag on 1-10
bz = np.array([r["bpm"] for r in rows]); bz = (bz - d["bpm_mean"]) / d["bpm_std"]

YM = float(y.mean())   # liblinear shrinks the intercept too, so fit around the mean
def fit(Xf, yf, C): return LinearSVR(C=C, epsilon=.5, loss="squared_epsilon_insensitive", max_iter=20000, dual="auto").fit(Xf, yf)
def loo(Xf, C):
    p = np.empty(len(y))
    for i in range(len(y)):
        m = np.arange(len(y)) != i
        p[i] = fit(Xf[m], y[m] - YM, C).predict(Xf[i:i + 1])[0] + YM
    return p

best = None
for with_bpm in (False, True):
    Xf = np.column_stack([X, bz]) if with_bpm else X
    for C in (.003, .01, .03, .1, .3):
        p = loo(Xf, C)
        a, b = np.polyfit(p, y, 1) if np.ptp(p) > 1e-6 else (1.0, 0.0)   # stretch shrunken scores back onto 2/5.5/9
        pc = np.clip(a * p + b, 1, 10)
        agree = close(pc, lab)
        cand = {"mae": float(np.abs(pc - y).mean()), "with_bpm": with_bpm, "C": C, "agree": agree, "rho": spearman(p, y), "Xf": Xf, "a": a, "b": b}
        if best is None or agree > best["agree"] + (.05 if with_bpm and not best["with_bpm"] else 0): best = cand
old = np.array([r["old"] for r in rows])
m = fit(best["Xf"], y - YM, best["C"])
coef = (m.coef_ * best["a"]).tolist()
print(json.dumps({"names": d["names"], "mean": d["mean"], "std": d["std"], "bpm_mean": d["bpm_mean"], "bpm_std": d["bpm_std"],
                  "coef": coef[:len(d["names"])], "bpm_coef": coef[-1] if best["with_bpm"] else 0.0, "intercept": float((m.intercept_[0] + YM) * best["a"] + best["b"]),
                  "n": len(rows), "C": best["C"], "with_bpm": best["with_bpm"],
                  "new": {"agree": round(best["agree"], 3), "rho": round(best["rho"], 3), "mae": round(best["mae"], 2)},
                  "old": {"agree": round(close(old, lab), 3), "rho": round(spearman(old, y), 3), "mae": round(float(np.abs(old - y).mean()), 2)},
                  "counts": {str(k): int((lab == k).sum()) for k in (1, 2, 3, 4, 5)}}))
