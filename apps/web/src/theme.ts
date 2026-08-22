import type { GlobalThemeOverrides } from 'naive-ui'

const paper = '#F3F6F4'
const ink = '#1C2420'
const leaf = '#3D6B54'
const leafHover = '#4A7D64'
const leafPressed = '#2F5442'
const bark = '#6B746F'
const slip = '#FFFEFB'
const clay = '#B4532A'
const clayHover = '#C46238'
const clayPressed = '#9A4624'
const hairline = '#D5DCD8'

/** Eucalyptus Ink — one accent (Leaf). Success/info share Leaf; warning/error share Clay. */
export const cssTokens: Record<string, string> = {
  '--paper': '#F3F6F4',
  '--ink': '#1C2420',
  '--leaf': '#3D6B54',
  '--bark': '#6B746F',
  '--slip': '#FFFEFB',
  '--clay': '#B4532A',
  '--hairline': '#D5DCD8',
  '--motion-fast': '120ms',
  '--motion-med': '220ms',
  '--motion-slow': '380ms',
  '--motion-ease': 'cubic-bezier(0.22, 1, 0.36, 1)',
  '--motion-wash': '22s',
}

export function ensureRootTokens() {
  if (typeof document === 'undefined') return
  const reduce =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const root = document.documentElement
  for (const [name, value] of Object.entries(cssTokens)) {
    const next =
      reduce &&
      (name === '--motion-fast' ||
        name === '--motion-med' ||
        name === '--motion-slow' ||
        name === '--motion-wash')
        ? '0ms'
        : value
    root.style.setProperty(name, next)
  }
  if (document.getElementById('kaola-eucalyptus-tokens')) return
  const style = document.createElement('style')
  style.id = 'kaola-eucalyptus-tokens'
  const decls = Object.entries(cssTokens)
    .map(([name, value]) => `${name}: ${value};`)
    .join(' ')
  style.textContent = `:root { ${decls} } @media (prefers-reduced-motion: reduce) { :root { --motion-fast: 0ms; --motion-med: 0ms; --motion-slow: 0ms; --motion-wash: 0ms; } }`
  document.head.appendChild(style)
}

export const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: leaf,
    primaryColorHover: leafHover,
    primaryColorPressed: leafPressed,
    primaryColorSuppl: leaf,
    infoColor: leaf,
    infoColorHover: leafHover,
    infoColorPressed: leafPressed,
    infoColorSuppl: leaf,
    successColor: leaf,
    successColorHover: leafHover,
    successColorPressed: leafPressed,
    successColorSuppl: leaf,
    warningColor: clay,
    warningColorHover: clayHover,
    warningColorPressed: clayPressed,
    warningColorSuppl: clay,
    errorColor: clay,
    errorColorHover: clayHover,
    errorColorPressed: clayPressed,
    errorColorSuppl: clay,
    bodyColor: paper,
    cardColor: slip,
    modalColor: slip,
    popoverColor: slip,
    tableColor: slip,
    tagColor: slip,
    inputColor: slip,
    actionColor: paper,
    hoverColor: 'rgba(61, 107, 84, 0.08)',
    pressedColor: 'rgba(61, 107, 84, 0.14)',
    textColorBase: ink,
    textColor1: ink,
    textColor2: ink,
    textColor3: bark,
    textColorDisabled: bark,
    placeholderColor: bark,
    iconColor: ink,
    borderColor: hairline,
    dividerColor: hairline,
    fontFamily: 'PingFang SC, "Noto Sans SC", ui-sans-serif, sans-serif',
    fontFamilyMono: 'ui-monospace, "IBM Plex Mono", monospace',
  },
  Card: {
    color: slip,
    textColor: ink,
    titleTextColor: ink,
    borderColor: hairline,
  },
  Button: {
    textColorPrimary: slip,
    colorPrimary: leaf,
    colorHoverPrimary: leafHover,
    colorPressedPrimary: leafPressed,
    colorFocusPrimary: leaf,
    textColorError: slip,
    colorError: clay,
    colorHoverError: clayHover,
    colorPressedError: clayPressed,
  },
  Input: {
    color: slip,
    textColor: ink,
    caretColor: leaf,
    borderHover: leaf,
    borderFocus: leaf,
    boxShadowFocus: '0 0 0 2px rgba(61, 107, 84, 0.28)',
  },
  InternalSelection: {
    color: slip,
    textColor: ink,
    borderHover: leaf,
    borderFocus: leaf,
    boxShadowActive: '0 0 0 2px rgba(61, 107, 84, 0.28)',
    boxShadowFocus: '0 0 0 2px rgba(61, 107, 84, 0.28)',
  },
  Switch: {
    railColorActive: leaf,
  },
}
