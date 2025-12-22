export { CommentExtractor, ExtractedComment, ProcessedContent } from './CommentExtractor';
export { getLanguageConfig, isPlainTextLanguage, LanguageConfig, CommentPattern } from './LanguagePatterns';
export {
    ContentProcessor,
    MarkdownProcessor,
    JsonProcessor,
    HtmlProcessor,
    EnhancedMarkdownProcessor,
    getProcessor,
    registerProcessor,
    ProcessedText,
    ProtectedRegion,
    EnhancedProcessedText
} from './ContentProcessor';
export { CodeBlockCommentExtractor, CodeBlockCommentResult } from './CodeBlockCommentExtractor';
