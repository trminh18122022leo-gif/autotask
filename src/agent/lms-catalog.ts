/** Catalog of 100+ supported Vietnamese & International LMS / MOOC / E-Learning platforms */

export interface KnownPlatformEntry {
  url: string;
  host: string;
  name: string;
  patterns: RegExp[];
}

/** Allowed hostnames covering all 100 websites in danh_sach_100_website_LMS_Moodle_hoc_truc_tuyen.xlsx + SohoA, HUSTack, MOOC & Vietnamese universities */
export const CATALOG_ALLOWED_HOSTS: readonly string[] = [
  // HUST & Vietnamese University LMS / MOOCs / Coding Portals
  'lms.hust.edu.vn',
  'lms.fintech.hust.edu.vn',
  'id.hust.edu.vn',
  'sso.hust.edu.vn',
  'fami.hust.edu.vn',
  'sohoa.hust.edu.vn',
  'hustack.soict.ai',
  'openerp.soict.ai',
  'hustack.edu.vn',
  'daotao.ai',
  'mooc.daotao.ai',
  'mooc.hust.edu.vn',
  'courses.vnu.edu.vn',
  'lms.ueh.edu.vn',
  'lms.huce.edu.vn',
  'lms.tuaf.edu.vn',
  'elearning.utc.edu.vn',
  'lms3.ufl.udn.vn',
  'elearning.naem.edu.vn',
  'lms.hvpnvn.edu.vn',
  'lms.umt.edu.vn',
  'lms.lhu.edu.vn',
  'lms.hvu.edu.vn',
  'lms.hmu.edu.vn',
  'lms.tqu.edu.vn',
  'lms.ptit.edu.vn',
  'e-learning.hcmut.edu.vn',
  'courses.uit.edu.vn',
  'utexlms.hcmute.edu.vn',
  'lms.neu.edu.vn',
  'lms.ftu.edu.vn',
  // Vietnamese K-12 LMS, Practice & E-learning Platforms
  'k12online.vn',
  'lms.vnedu.vn',
  'vnedu.vn',
  'olm.vn',
  'vio.edu.vn',
  'azota.vn',
  'shub.edu.vn',
  'megaschool.vn',
  'hoola.vn',
  'edubit.vn',
  'hachium.com',
  'violet.vn',
  'vndoc.com',
  'loigiaihay.com',
  'vungoi.vn',
  'hoc24.vn',
  'hoc247.net',
  'hocmai.vn',
  'tuyensinh247.com',
  'vietjack.com',
  'vuihoc.vn',
  'moon.vn',
  'onluyen.vn',
  '789.vn',
  'vinastudy.vn',
  'thithu.edu.vn',
  'toploigiai.vn',
  'icantech.vn',
  'unica.vn',
  'kyna.vn',
  'edumall.vn',
  'funix.edu.vn',
  'topica.asia',
  'edupia.vn',
  'prep.vn',
  'zim.vn',
  // International LMS & Forms
  'moodle.org',
  'moodlecloud.com',
  'gnomio.com',
  'instructure.com',
  'blackboard.com',
  'd2l.com',
  'schoology.com',
  'classroom.google.com',
  'docs.google.com',
  'forms.office.com',
  'forms.microsoft.com',
  'openedx.org',
  'sakailms.org',
  'chamilo.org',
  'ilias.de',
  'openolat.com',
  'formalms.org',
  'totara.com',
  'talentlms.com',
  'docebo.com',
  'learnupon.com',
  'absorblms.com',
  'ispringsolutions.com',
  '360learning.com',
  'cornerstoneondemand.com',
  'litmos.com',
  'itslearning.com',
  // International MOOC & Interactive STEM/Coding Platforms
  'coursera.org',
  'udemy.com',
  'edx.org',
  'khanacademy.org',
  'futurelearn.com',
  'alison.com',
  'open.edu',
  'ocw.mit.edu',
  'harvardonline.harvard.edu',
  'online.stanford.edu',
  'linkedin.com',
  'pluralsight.com',
  'skillshare.com',
  'masterclass.com',
  'codecademy.com',
  'freecodecamp.org',
  'datacamp.com',
  'brilliant.org',
  'udacity.com',
  'sololearn.com',
  'saylor.org',
  'nptel.ac.in',
  'swayam.gov.in',
  'fun-mooc.fr',
  'openstax.org'
];

export const KNOWN_PLATFORM_ENTRIES: readonly KnownPlatformEntry[] = [
  {
    url: 'https://lms.fintech.hust.edu.vn',
    host: 'lms.fintech.hust.edu.vn',
    name: 'Moodle Fintech HUST',
    patterns: [/\bfintech\s*hust\b|\blms\s*fintech\b/i]
  },
  {
    url: 'https://fami.hust.edu.vn/sohoa',
    host: 'fami.hust.edu.vn',
    name: 'SohoA / FAMI HUST',
    patterns: [/\bsohoa\b|\bsố\s*hóa\s*(?:fami|hust|bách\s*khoa)?\b|\bfami(?:\s*hust)?\b/i]
  },
  {
    url: 'https://hustack.soict.ai',
    host: 'hustack.soict.ai',
    name: 'HUSTack SOICT HUST',
    patterns: [/\bhustack\b|\bhust\s*stack\b/i]
  },
  {
    url: 'https://mooc.hust.edu.vn',
    host: 'mooc.hust.edu.vn',
    name: 'MOOC HUST',
    patterns: [/\bmooc\s*hust\b|\bhust\s*mooc\b/i]
  },
  {
    url: 'https://daotao.ai',
    host: 'daotao.ai',
    name: 'MOOC / Đào tạo AI',
    patterns: [/\bdaotao\.ai\b|\bđào\s*tạo\s*ai\b|\bmooc\b/i]
  },
  {
    url: 'https://lms.hust.edu.vn',
    host: 'lms.hust.edu.vn',
    name: 'LMS HUST',
    patterns: [/\blms\s*hust\b|\bhust\s*lms\b/i]
  },
  {
    url: 'https://courses.vnu.edu.vn',
    host: 'courses.vnu.edu.vn',
    name: 'LMS ĐHQGHN (VNU)',
    patterns: [/\blms\s*vnu\b|\bvnu\s*lms\b|\bcourses\.vnu\b/i]
  },
  {
    url: 'https://lms.ueh.edu.vn',
    host: 'lms.ueh.edu.vn',
    name: 'UEH LMS',
    patterns: [/\bueh\s*lms\b|\blms\s*ueh\b/i]
  },
  {
    url: 'https://lms.huce.edu.vn',
    host: 'lms.huce.edu.vn',
    name: 'HUCE LMS',
    patterns: [/\bhuce\s*lms\b|\blms\s*huce\b/i]
  },
  {
    url: 'https://lms.tuaf.edu.vn',
    host: 'lms.tuaf.edu.vn',
    name: 'TUAF LMS',
    patterns: [/\btuaf\s*lms\b|\blms\s*tuaf\b/i]
  },
  {
    url: 'https://elearning.utc.edu.vn',
    host: 'elearning.utc.edu.vn',
    name: 'UTC E-Learning',
    patterns: [/\butc\s*(?:lms|e-?learning)\b|\b(?:lms|e-?learning)\s*utc\b/i]
  },
  {
    url: 'https://lms.ptit.edu.vn',
    host: 'lms.ptit.edu.vn',
    name: 'PTIT LMS',
    patterns: [/\bptit\s*lms\b|\blms\s*ptit\b/i]
  },
  {
    url: 'https://e-learning.hcmut.edu.vn',
    host: 'e-learning.hcmut.edu.vn',
    name: 'BKeL HCMUT',
    patterns: [/\bbkel\b|\bhcmut\s*(?:lms|e-?learning)\b|\be-?learning\s*hcmut\b/i]
  },
  {
    url: 'https://courses.uit.edu.vn',
    host: 'courses.uit.edu.vn',
    name: 'UIT Courses',
    patterns: [/\buit\s*(?:lms|courses)\b|\b(?:lms|courses)\s*uit\b/i]
  },
  {
    url: 'https://utexlms.hcmute.edu.vn',
    host: 'utexlms.hcmute.edu.vn',
    name: 'UTEx HCMUTE',
    patterns: [/\butex\b|\bhcmute\s*lms\b/i]
  },
  {
    url: 'https://lms.neu.edu.vn',
    host: 'lms.neu.edu.vn',
    name: 'NEU LMS',
    patterns: [/\bNEU\s*LMS\b|\bLMS\s*NEU\b|\blms\.neu\.edu\.vn\b/]
  },
  {
    url: 'https://lms.ftu.edu.vn',
    host: 'lms.ftu.edu.vn',
    name: 'FTU LMS',
    patterns: [/\bftu\s*lms\b|\blms\s*ftu\b/i]
  },
  {
    url: 'https://lms.hmu.edu.vn',
    host: 'lms.hmu.edu.vn',
    name: 'HMU LMS',
    patterns: [/\bhmu\s*lms\b|\blms\s*hmu\b/i]
  },
  {
    url: 'https://k12online.vn',
    host: 'k12online.vn',
    name: 'K12Online',
    patterns: [/\bk12online\b/i]
  },
  {
    url: 'https://lms.vnedu.vn',
    host: 'lms.vnedu.vn',
    name: 'vnEdu LMS',
    patterns: [/\bvnedu\b/i]
  },
  {
    url: 'https://olm.vn',
    host: 'olm.vn',
    name: 'OLM',
    patterns: [/\bolm(?:\.vn)?\b/i]
  },
  {
    url: 'https://vio.edu.vn',
    host: 'vio.edu.vn',
    name: 'VioEdu',
    patterns: [/\bvioedu\b|\bvio\.edu\.vn\b/i]
  },
  {
    url: 'https://azota.vn',
    host: 'azota.vn',
    name: 'Azota',
    patterns: [/\bazota\b/i]
  },
  {
    url: 'https://shub.edu.vn',
    host: 'shub.edu.vn',
    name: 'SHub Classroom',
    patterns: [/\bshub\b/i]
  },
  {
    url: 'https://hocmai.vn',
    host: 'hocmai.vn',
    name: 'HOCMAI',
    patterns: [/\bhocmai\b|\bhọc\s*mãi\b/i]
  },
  {
    url: 'https://tuyensinh247.com',
    host: 'tuyensinh247.com',
    name: 'Tuyensinh247',
    patterns: [/\btuyensinh247\b/i]
  },
  {
    url: 'https://vietjack.com',
    host: 'vietjack.com',
    name: 'VietJack',
    patterns: [/\bvietjack\b/i]
  },
  {
    url: 'https://vuihoc.vn',
    host: 'vuihoc.vn',
    name: 'Vuihoc',
    patterns: [/\bvuihoc\b/i]
  },
  {
    url: 'https://moon.vn',
    host: 'moon.vn',
    name: 'Moon.vn',
    patterns: [/\bmoon\.vn\b/i]
  },
  {
    url: 'https://onluyen.vn',
    host: 'onluyen.vn',
    name: 'Onluyen',
    patterns: [/\bonluyen(?:\.vn)?\b/i]
  },
  {
    url: 'https://funix.edu.vn',
    host: 'funix.edu.vn',
    name: 'FUNiX',
    patterns: [/\bfunix\b/i]
  },
  {
    url: 'https://www.coursera.org',
    host: 'coursera.org',
    name: 'Coursera',
    patterns: [/\bcoursera\b/i]
  },
  {
    url: 'https://www.edx.org',
    host: 'edx.org',
    name: 'edX',
    patterns: [/\bedx\b|\bopen\s*edx\b/i]
  },
  {
    url: 'https://www.udemy.com',
    host: 'udemy.com',
    name: 'Udemy',
    patterns: [/\budemy\b/i]
  },
  {
    url: 'https://www.khanacademy.org',
    host: 'khanacademy.org',
    name: 'Khan Academy',
    patterns: [/\bkhan\s*academy\b/i]
  },
  {
    url: 'https://classroom.google.com',
    host: 'classroom.google.com',
    name: 'Google Classroom',
    patterns: [/\bgoogle\s*classroom\b/i]
  },
  {
    url: 'https://www.codecademy.com',
    host: 'codecademy.com',
    name: 'Codecademy',
    patterns: [/\bcodecademy\b/i]
  },
  {
    url: 'https://www.freecodecamp.org',
    host: 'freecodecamp.org',
    name: 'freeCodeCamp',
    patterns: [/\bfreecodecamp\b/i]
  },
  {
    url: 'https://www.datacamp.com',
    host: 'datacamp.com',
    name: 'DataCamp',
    patterns: [/\bdatacamp\b/i]
  },
  {
    url: 'https://brilliant.org',
    host: 'brilliant.org',
    name: 'Brilliant',
    patterns: [/\bbrilliant\.org\b|\bvào\s+brilliant\b/i]
  }
];

/** Resolves a known Vietnamese/international LMS/MOOC platform mentioned naturally in user text */
export function resolveKnownPlatformFromPrompt(prompt: string): { url: string; host: string; name: string } | undefined {
  const text = String(prompt || '').trim();
  if (!text) return undefined;
  for (const entry of KNOWN_PLATFORM_ENTRIES) {
    if (entry.patterns.some(re => re.test(text))) {
      return { url: entry.url, host: entry.host, name: entry.name };
    }
  }
  return undefined;
}
