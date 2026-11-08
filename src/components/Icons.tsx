import type { ReactNode, SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function make(children: ReactNode, fill = false) {
  return function Icon({ size, ...rest }: P) {
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill={fill ? 'currentColor' : 'none'}
        stroke={fill ? 'none' : 'currentColor'}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...rest}
      >
        {children}
      </svg>
    );
  };
}

export const IHome = make(<><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /><path d="M10 20v-6h4v6" /></>);
export const IGrid = make(<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>);
export const IRocket = make(<><path d="M5 15c-1.5 1.3-2 5-2 5s3.7-.5 5-2" /><path d="M12 15l-3-3a22 22 0 0 1 2-4 12 12 0 0 1 11-5c0 3-1 8-5 11a22 22 0 0 1-4 2z" /><circle cx="16" cy="8" r="1.4" /></>);
export const ITrophy = make(<><path d="M8 21h8M12 17v4" /><path d="M7 4h10v5a5 5 0 0 1-10 0z" /><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" /></>);
export const IUser = make(<><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" /></>);
export const IBook = make(<><path d="M4 5a2 2 0 0 1 2-2h13v17H6a2 2 0 0 0-2 2z" /><path d="M4 19V5" /><path d="M9 7h6" /></>);
export const ISearch = make(<><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>);
export const ICopy = make(<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>);
export const IExt = make(<><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>);
export const ICheck = make(<path d="M5 12.5l4.5 4.5L19 7.5" />);
export const IX = make(<path d="M6 6l12 12M18 6L6 18" />);
/** the X (formerly Twitter) logo */
export const IXLogo = make(<path d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.78zm-1.08 16.16h1.7L7.4 4.74H5.58z" />, true);
export const IChevDown =make(<path d="M6 9l6 6 6-6" />);
export const IArrowLeft = make(<path d="M19 12H5M11 6l-6 6 6 6" />);
export const IGlobe = make(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>);
export const IWallet = make(<><path d="M3 7a2 2 0 0 1 2-2h13v4" /><rect x="3" y="7" width="18" height="13" rx="2" /><circle cx="16.5" cy="13.5" r="1.2" fill="currentColor" /></>);
export const ILock = make(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>);
export const IShield = make(<path d="M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6z" />);
export const IFlame = make(<path d="M12 3c1 4 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 1-9z" />);
export const IClock = make(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
export const ICoins = make(<><circle cx="9" cy="9" r="6" /><path d="M15 9.5A6 6 0 1 1 9.5 15" /></>);
export const IInfo = make(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>);
export const IMenu = make(<path d="M4 7h16M4 12h16M4 17h16" />);
export const IGift = make(<><rect x="3" y="8" width="18" height="4" rx="1" /><path d="M12 8v13M5 12v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8" /><path d="M12 8C9 8 7 6.5 7.5 5S10.5 4 12 8c1.5-4 3.5-4 4.5-3S15 8 12 8z" /></>);
export const IImage = make(<><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.7" /><path d="M21 16l-5-5-8 8" /></>);
export const ISwap = make(<><path d="M7 4L3 8l4 4" /><path d="M3 8h14" /><path d="M17 20l4-4-4-4" /><path d="M21 16H7" /></>);
export const IBolt = make(<path d="M13 2L4 14h7l-1 8 9-12h-7z" />);
export const IUsers = make(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2 .6 3.5 2.4 3.5 6" /></>);
export const IDownload = make(<><path d="M12 4v11" /><path d="M7 11l5 5 5-5" /><path d="M5 20h14" /></>);
export const IPlus = make(<path d="M12 5v14M5 12h14" />);

export const IconX = make(<path d="M3 3h4.6l4.4 6 5.2-6H21l-7.4 8.4L21 21h-4.6l-4.7-6.3L6.3 21H3l7.8-8.8z" />, true);
export const IconTelegram = make(<path d="M21.5 3.2L2.7 10.6c-.9.4-.9 1.2-.2 1.4l4.8 1.5 1.9 5.8c.2.6.4.7.9.7.4 0 .6-.2.9-.4l2.3-2.2 4.8 3.5c.9.5 1.5.2 1.7-.8L22.8 4.6c.3-1.3-.5-1.8-1.3-1.4zM9 13.3l9.3-5.9c.4-.3.8 0 .5.2l-7.6 6.9-.3 3.2z" />, true);
