package com.arpi.odoo.workentry;

import com.arpi.odoo.workentry.WorkEntryTypes.Entry;
import com.intellij.codeInsight.hints.declarative.HintFormat;
import com.intellij.codeInsight.hints.declarative.InlayHintsCollector;
import com.intellij.codeInsight.hints.declarative.InlayHintsProvider;
import com.intellij.codeInsight.hints.declarative.InlayTreeSink;
import com.intellij.codeInsight.hints.declarative.InlineInlayPosition;
import com.intellij.codeInsight.hints.declarative.SharedBypassCollector;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.project.DumbService;
import com.intellij.psi.PsiElement;
import com.intellij.psi.PsiFile;
import kotlin.Unit;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.util.List;

/** Inline hint with the generic work entry type name right after a code literal, like parameter name hints. */
public final class WorkEntryInlayHintsProvider implements InlayHintsProvider {

    @Override
    public @Nullable InlayHintsCollector createCollector(@NotNull PsiFile file, @NotNull Editor editor) {
        if (DumbService.isDumb(file.getProject())) {
            return null;
        }
        return new Collector();
    }

    private static final class Collector implements SharedBypassCollector {

        @Override
        public void collectFromElement(@NotNull PsiElement element, @NotNull InlayTreeSink sink) {
            String code = WorkEntryTypes.codeLiteral(element);
            if (code == null) {
                return;
            }
            Entry entry = WorkEntryTypes.findGeneric(element.getProject(), code);
            if (entry == null) {
                return;
            }
            String label = entry.rec().name == null ? entry.rec().xmlid : entry.rec().name;
            sink.addPresentation(new InlineInlayPosition(element.getTextRange().getEndOffset(), true, 0), List.of(),
                    entry.rec().xmlid, HintFormat.Companion.getDefault(), builder -> {
                        builder.text(label, null);
                        return Unit.INSTANCE;
                    });
        }
    }
}
