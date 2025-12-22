export interface CommentPattern {
    single?: RegExp;      // Single-line comment pattern
    multiStart?: RegExp;  // Multi-line comment start
    multiEnd?: RegExp;    // Multi-line comment end
    docBlock?: RegExp;    // Documentation block (e.g., /** */, """)
}

export interface LanguageConfig {
    id: string;
    extensions: string[];
    patterns: CommentPattern;
    preserveIndent: boolean;
}

// Language configurations with comment patterns
export const languageConfigs: Record<string, LanguageConfig> = {
    // C-style languages
    csharp: {
        id: 'csharp',
        extensions: ['.cs'],
        patterns: {
            single: /\/\/.*$/gm,
            multiStart: /\/\*/,
            multiEnd: /\*\//,
            docBlock: /\/\/\/.*$/gm
        },
        preserveIndent: true
    },
    java: {
        id: 'java',
        extensions: ['.java'],
        patterns: {
            single: /\/\/.*$/gm,
            multiStart: /\/\*/,
            multiEnd: /\*\//,
            docBlock: /\/\*\*[\s\S]*?\*\//g
        },
        preserveIndent: true
    },
    javascript: {
        id: 'javascript',
        extensions: ['.js', '.jsx', '.mjs'],
        patterns: {
            single: /\/\/.*$/gm,
            multiStart: /\/\*/,
            multiEnd: /\*\//
        },
        preserveIndent: true
    },
    typescript: {
        id: 'typescript',
        extensions: ['.ts', '.tsx'],
        patterns: {
            single: /\/\/.*$/gm,
            multiStart: /\/\*/,
            multiEnd: /\*\//
        },
        preserveIndent: true
    },
    cpp: {
        id: 'cpp',
        extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.h'],
        patterns: {
            single: /\/\/.*$/gm,
            multiStart: /\/\*/,
            multiEnd: /\*\//
        },
        preserveIndent: true
    },
    c: {
        id: 'c',
        extensions: ['.c', '.h'],
        patterns: {
            single: /\/\/.*$/gm,
            multiStart: /\/\*/,
            multiEnd: /\*\//
        },
        preserveIndent: true
    },
    go: {
        id: 'go',
        extensions: ['.go'],
        patterns: {
            single: /\/\/.*$/gm,
            multiStart: /\/\*/,
            multiEnd: /\*\//
        },
        preserveIndent: true
    },
    rust: {
        id: 'rust',
        extensions: ['.rs'],
        patterns: {
            single: /\/\/.*$/gm,
            multiStart: /\/\*/,
            multiEnd: /\*\//,
            docBlock: /\/\/[\/!].*$/gm
        },
        preserveIndent: true
    },
    swift: {
        id: 'swift',
        extensions: ['.swift'],
        patterns: {
            single: /\/\/.*$/gm,
            multiStart: /\/\*/,
            multiEnd: /\*\//
        },
        preserveIndent: true
    },
    kotlin: {
        id: 'kotlin',
        extensions: ['.kt', '.kts'],
        patterns: {
            single: /\/\/.*$/gm,
            multiStart: /\/\*/,
            multiEnd: /\*\//
        },
        preserveIndent: true
    },
    // Hash-style languages
    python: {
        id: 'python',
        extensions: ['.py', '.pyw'],
        patterns: {
            single: /#.*$/gm,
            multiStart: /"""/,
            multiEnd: /"""/,
            docBlock: /"""[\s\S]*?"""|'''[\s\S]*?'''/g
        },
        preserveIndent: true
    },
    ruby: {
        id: 'ruby',
        extensions: ['.rb'],
        patterns: {
            single: /#.*$/gm,
            multiStart: /=begin/,
            multiEnd: /=end/
        },
        preserveIndent: true
    },
    perl: {
        id: 'perl',
        extensions: ['.pl', '.pm'],
        patterns: {
            single: /#.*$/gm
        },
        preserveIndent: true
    },
    shellscript: {
        id: 'shellscript',
        extensions: ['.sh', '.bash', '.zsh'],
        patterns: {
            single: /#.*$/gm
        },
        preserveIndent: true
    },
    powershell: {
        id: 'powershell',
        extensions: ['.ps1', '.psm1'],
        patterns: {
            single: /#.*$/gm,
            multiStart: /<#/,
            multiEnd: /#>/
        },
        preserveIndent: true
    },
    yaml: {
        id: 'yaml',
        extensions: ['.yml', '.yaml'],
        patterns: {
            single: /#.*$/gm
        },
        preserveIndent: true
    },
    // SQL
    sql: {
        id: 'sql',
        extensions: ['.sql'],
        patterns: {
            single: /--.*$/gm,
            multiStart: /\/\*/,
            multiEnd: /\*\//
        },
        preserveIndent: true
    },
    // Markup/Web
    html: {
        id: 'html',
        extensions: ['.html', '.htm'],
        patterns: {
            multiStart: /<!--/,
            multiEnd: /-->/
        },
        preserveIndent: true
    },
    xml: {
        id: 'xml',
        extensions: ['.xml', '.xsl', '.xslt'],
        patterns: {
            multiStart: /<!--/,
            multiEnd: /-->/
        },
        preserveIndent: true
    },
    css: {
        id: 'css',
        extensions: ['.css', '.scss', '.sass', '.less'],
        patterns: {
            multiStart: /\/\*/,
            multiEnd: /\*\//
        },
        preserveIndent: true
    },
    php: {
        id: 'php',
        extensions: ['.php'],
        patterns: {
            single: /(?:\/\/|#).*$/gm,
            multiStart: /\/\*/,
            multiEnd: /\*\//
        },
        preserveIndent: true
    },
    lua: {
        id: 'lua',
        extensions: ['.lua'],
        patterns: {
            single: /--(?!\[\[).*$/gm,
            multiStart: /--\[\[/,
            multiEnd: /\]\]/
        },
        preserveIndent: true
    }
};

// Plain text languages that should be fully translated
// Note: markdown, json, html have dedicated ContentProcessors
export const plainTextLanguages = new Set([
    'plaintext',
    'text',
    'txt',
    'log'
]);

export function getLanguageConfig(languageId: string): LanguageConfig | null {
    return languageConfigs[languageId] || null;
}

export function isPlainTextLanguage(languageId: string): boolean {
    return plainTextLanguages.has(languageId);
}
