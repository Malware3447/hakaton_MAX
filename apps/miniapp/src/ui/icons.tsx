import type { SVGProps } from 'react'

// Иконки в духе MAX UI: контур 1.8, скругления, currentColor. В самой библиотеке их шесть.

type P = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 24, children, ...rest }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  )
}

export const IconBack = (p: P) => (
  <Svg {...p}>
    <path d="M15 5l-7 7 7 7" />
  </Svg>
)
export const IconBell = (p: P) => (
  <Svg {...p}>
    <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16z" />
    <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
  </Svg>
)
export const IconFilter = (p: P) => (
  <Svg {...p}>
    <path d="M4 6h16M7 12h10M10 18h4" />
  </Svg>
)
export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Svg>
)
export const IconTruck = (p: P) => (
  <Svg {...p}>
    <path d="M3 6h11v10H3zM14 10h4l3 3v3h-7" />
    <circle cx="7" cy="17.5" r="1.8" />
    <circle cx="17" cy="17.5" r="1.8" />
  </Svg>
)
export const IconBuilding = (p: P) => (
  <Svg {...p}>
    <path d="M4 20V5l8-2v17M12 9l8 2v9M3 20h18M7.5 8h1M7.5 12h1M7.5 16h1M15.5 14h1M15.5 17h1" />
  </Svg>
)
export const IconQr = (p: P) => (
  <Svg {...p}>
    <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2M14 18h2M18 18h2v2" />
  </Svg>
)
export const IconDownload = (p: P) => (
  <Svg {...p}>
    <path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" />
  </Svg>
)
export const IconCamera = (p: P) => (
  <Svg {...p}>
    <path d="M4 8h3l1.5-2h7L17 8h3v11H4z" />
    <circle cx="12" cy="13" r="3.3" />
  </Svg>
)
export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)
export const IconChat = (p: P) => (
  <Svg {...p}>
    <path d="M5 5h14v10H10l-4 4v-4H5z" />
  </Svg>
)
export const IconSearch = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6" />
    <path d="M20 20l-4.5-4.5" />
  </Svg>
)
export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
)
export const IconSignature = (p: P) => (
  <Svg {...p}>
    <path d="M4 18c3-6 5-10 7-10 2.5 0-1.5 8 1 8 1.5 0 2.5-3 4-3 1 0 1 2 2.5 2M4 21h16" />
  </Svg>
)
export const IconAlert = (p: P) => (
  <Svg {...p}>
    <path d="M12 4l9 16H3z" />
    <path d="M12 10v4M12 17.2v.3" />
  </Svg>
)
export const IconUserPlus = (p: P) => (
  <Svg {...p}>
    <circle cx="10" cy="8" r="3.5" />
    <path d="M3.5 20c.8-3.5 3.3-5.5 6.5-5.5s5.7 2 6.5 5.5M18 7v6M15 10h6" />
  </Svg>
)
export const IconEdit = (p: P) => (
  <Svg {...p}>
    <path d="M4 20h4L19 9l-4-4L4 16z" />
  </Svg>
)
