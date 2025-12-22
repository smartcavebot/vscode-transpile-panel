export { CommentExtractor, ExtractedComment, ProcessedContent } from './CommentExtractor';
export { getLanguageConfig, isPlainTextLanguage, LanguageConfig, CommentPattern } from './LanguagePatterns';
export {
    ContentProcessor,
    MarkdownProcessor,
    JsonProcessor,
    HtmlProcessor,
    getProcessor,
    registerProcessor,
    ProcessedText,
    ProtectedRegion
} from './ContentProcessor';
