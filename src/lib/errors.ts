const DEFAULT_BANGLA: Record<string, string> = {
  unauthenticated: 'আগে সাইন ইন করুন।',
  forbidden: 'এই কাজটি করার অনুমতি আপনার নেই।',
  not_found: 'তথ্যটি পাওয়া যায়নি।',
  validation_error: 'তথ্যগুলো আবার দেখুন — কিছু ঘরে সমস্যা আছে।',
  conflict: 'এই তথ্য আগে থেকেই আছে।',
  internal_error: 'সার্ভারে সমস্যা হয়েছে। পরে আবার চেষ্টা করুন।',
  account_pending: 'আপনার অ্যাকাউন্টটি অ্যাডমিনের অনুমোদনের অপেক্ষায় আছে।',
  account_suspended: 'এই অ্যাকাউন্টটি স্থগিত করা হয়েছে। সহায়তা কেন্দ্রে যোগাযোগ করুন।',
  account_removed: 'এই অ্যাকাউন্টটি মুছে ফেলা হয়েছে।',
  invalid_credentials: 'মোবাইল নম্বর বা পাসওয়ার্ড ঠিক নেই।',
  invalid_refresh_token: 'আপনার সেশন শেষ হয়েছে। আবার সাইন ইন করুন।',
  invalid_current_password: 'বর্তমান পাসওয়ার্ডটি ঠিক নেই।',
  invalid_reset_token: 'রিসেট কোডটি সঠিক নয় বা মেয়াদ শেষ হয়েছে।',
  reset_unavailable: 'পাসওয়ার্ড রিসেট এখনো চালু হয়নি।',
  mobile_taken: 'এই মোবাইল নম্বর দিয়ে আগে থেকেই অ্যাকাউন্ট আছে।',
  origin_not_allowed: 'এই উৎস থেকে অনুরোধ অনুমোদিত নয়।',
  rate_limited: 'অনেকবার চেষ্টা করা হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।',
  ai_unavailable: 'এআই উত্তর তৈরি করতে পারছে না। আবার চেষ্টা করুন।',
  storage_unavailable: 'ছবি সংরক্ষণ করা যাচ্ছে না। পরে আবার চেষ্টা করুন।',
  not_implemented: 'এই সুবিধাটি এখনো তৈরি হয়নি।',
};

/** A Bangla sentence for any client-facing failure, including legacy routes. */
export function banglaForFailure(code?: string, statusCode?: number): string {
  if (code && DEFAULT_BANGLA[code]) return DEFAULT_BANGLA[code]!;
  if (statusCode === 401) return 'আগে সাইন ইন করুন।';
  if (statusCode === 403) return 'এই কাজটি করার অনুমতি আপনার নেই।';
  if (statusCode === 404) return 'তথ্যটি পাওয়া যায়নি।';
  if (statusCode === 409) return 'এই তথ্য আগে থেকেই আছে।';
  if (statusCode === 429) return 'অনেকবার চেষ্টা করা হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।';
  return 'সার্ভারে সমস্যা হয়েছে। পরে আবার চেষ্টা করুন।';
}

/** An error that is safe to expose to the client with the given status code. */
export class AppError extends Error {
  public readonly messageBn: string;

  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    messageBn?: string,
  ) {
    super(message);
    this.name = 'AppError';
    // Every client-facing error has Bangla text. A new code without an explicit
    // translation still gets a safe Bangla sentence instead of leaking English.
    this.messageBn = messageBn ?? banglaForFailure(code, statusCode);
  }
}
