# Contributing to HBD 3D Craft

Thank you for contributing to **HBD 3D Craft**! We welcome new 3D toppings, animations, color themes, sound design, and internationalization translations.

---

## 🌿 Git Branching Strategy

- `feat/feature-name`: New toppings, themes, or visual effects
- `fix/bug-name`: Bug fixes and mobile rendering patches
- `perf/optimization`: WebGL or memory optimizations
- `docs/update`: Documentation improvements

---

## 💬 Conventional Commits

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```text
feat(cake): add procedural macarons topping mesh
fix(audio): handle safari web audio user-gesture lock
perf(webgl): optimize instanced mesh matrix updates
docs(readme): update system architecture diagrams
```

---

## 🛠️ Local Development & Pre-Flight Checklist

1. Clone and install dependencies: `npm install`
2. Start dev server: `npm run dev`
3. Verify production build: `npm run build`
4. Test microphone detection on desktop and mobile browsers
