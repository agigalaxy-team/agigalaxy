/*! Pinned SCSS excerpts from @payloadcms/ui 3.91.0.
MIT License

Copyright (c) 2018-2025 Payload CMS, Inc. <info@payloadcms.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/
export const payloadUiDuplicateStyleSources = Object.freeze([
  {
    "source": "dist/providers/RouteTransition/ProgressBar/index.scss",
    "expectedSource": "@layer payload-default {\n  .progress-bar {\n    position: fixed;\n    top: 0;\n    left: 0;\n    width: 100%;\n    height: 2px;\n    z-index: 9999;\n    opacity: 1;\n\n    &__progress {\n      height: 100%;\n      background-color: var(--theme-elevation-1000);\n      transition: width ease-in var(--transition-duration);\n    }\n\n    &--fade-out {\n      opacity: 0;\n      transition: opacity linear var(--transition-duration);\n      transition-delay: var(--transition-duration);\n    }\n  }\n}\n"
  },
  {
    "source": "dist/icons/X/index.scss",
    "expectedSource": "@import '../../scss/styles';\n\n@layer payload-default {\n  .icon--x {\n    .stroke {\n      stroke: currentColor;\n      stroke-width: $style-stroke-width-s;\n    }\n  }\n}\n"
  },
  {
    "source": "dist/icons/More/index.scss",
    "expectedSource": "@import '../../scss/styles';\n\n@layer payload-default {\n  .icon--more {\n    height: $baseline;\n    width: $baseline;\n\n    .fill {\n      fill: var(--theme-elevation-800);\n      stroke: currentColor;\n    }\n  }\n}\n"
  },
  {
    "source": "dist/fields/FieldLabel/index.scss",
    "expectedSource": "@import '../../scss/styles.scss';\n\n@layer payload-default {\n  label.field-label {\n    display: flex;\n    align-items: center;\n  }\n\n  label.field-label:not(.unstyled) {\n    @extend %body;\n    display: flex;\n    padding-bottom: base(0.25);\n    color: var(--theme-elevation-800);\n    font-family: var(--font-body);\n    [dir='ltr'] & {\n      margin-right: auto;\n    }\n    [dir='rtl'] & {\n      margin-left: auto;\n    }\n\n    .required {\n      color: var(--theme-error-500);\n    }\n\n    .required {\n      [dir='ltr'] & {\n        margin-left: base(0.25);\n      }\n      [dir='rtl'] & {\n        margin-right: base(0.25);\n      }\n    }\n  }\n\n  .localized {\n    @extend %body;\n    [dir='ltr'] & {\n      margin-left: base(0.25);\n    }\n    [dir='rtl'] & {\n      margin-right: base(0.25);\n    }\n  }\n}\n"
  },
  {
    "source": "dist/icons/Check/index.scss",
    "expectedSource": "@import '../../scss/styles';\n\n@layer payload-default {\n  .icon--check {\n    height: $baseline;\n    width: $baseline;\n\n    .stroke {\n      fill: none;\n      stroke: currentColor;\n      stroke-width: $style-stroke-width-m;\n    }\n  }\n}\n"
  },
  {
    "source": "dist/icons/Line/index.scss",
    "expectedSource": "@import '../../scss/styles';\n\n@layer payload-default {\n  .icon--line {\n    width: $baseline;\n    height: $baseline;\n\n    .stroke {\n      stroke: currentColor;\n      stroke-width: $style-stroke-width;\n    }\n  }\n}\n"
  },
  {
    "source": "dist/elements/IDLabel/index.scss",
    "expectedSource": "@import '../../scss/styles';\n\n@layer payload-default {\n  .id-label {\n    font-size: base(0.8);\n    line-height: base(1.2);\n    font-weight: normal;\n    color: var(--theme-elevation-600);\n    background: var(--theme-elevation-100);\n    padding: base(0.2) base(0.4);\n    border-radius: $style-radius-m;\n    display: inline-flex;\n    width: fit-content;\n  }\n}\n"
  },
  {
    "source": "dist/elements/RenderTitle/index.scss",
    "expectedSource": "@import '../../scss/styles.scss';\n\n@layer payload-default {\n  .render-title {\n    display: inline-block;\n    &__id {\n      vertical-align: middle;\n      position: relative;\n    }\n  }\n}\n"
  }
]);
// Full original-distribution rules, including declaration order and layer context.
// Deployment-minified equality was separately proved against the emitted CSS.
export const pinnedGlobalStyleRules = Object.freeze([
  {
    "selector": ".icon--x .stroke",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "stroke",
        "value": "currentColor",
        "important": false
      },
      {
        "property": "stroke-width",
        "value": "1px",
        "important": false
      }
    ]
  },
  {
    "selector": ".icon--more",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "height",
        "value": "1.5384615385rem",
        "important": false
      },
      {
        "property": "width",
        "value": "1.5384615385rem",
        "important": false
      }
    ]
  },
  {
    "selector": ".icon--more .fill",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "fill",
        "value": "var(--theme-elevation-800)",
        "important": false
      },
      {
        "property": "stroke",
        "value": "currentColor",
        "important": false
      }
    ]
  },
  {
    "selector": ".localized",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "font-size",
        "value": "13px",
        "important": false
      },
      {
        "property": "line-height",
        "value": "20px",
        "important": false
      },
      {
        "property": "font-weight",
        "value": "400",
        "important": false
      },
      {
        "property": "font-family",
        "value": "var(--font-body)",
        "important": false
      }
    ]
  },
  {
    "selector": "label.field-label:not(.unstyled)",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "font-size",
        "value": "13px",
        "important": false
      },
      {
        "property": "line-height",
        "value": "20px",
        "important": false
      },
      {
        "property": "font-weight",
        "value": "400",
        "important": false
      },
      {
        "property": "font-family",
        "value": "var(--font-body)",
        "important": false
      }
    ]
  },
  {
    "selector": "label.field-label",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "display",
        "value": "flex",
        "important": false
      },
      {
        "property": "align-items",
        "value": "center",
        "important": false
      }
    ]
  },
  {
    "selector": "label.field-label:not(.unstyled)",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "display",
        "value": "flex",
        "important": false
      },
      {
        "property": "padding-bottom",
        "value": "5px",
        "important": false
      },
      {
        "property": "color",
        "value": "var(--theme-elevation-800)",
        "important": false
      },
      {
        "property": "font-family",
        "value": "var(--font-body)",
        "important": false
      }
    ]
  },
  {
    "selector": "[dir=ltr] label.field-label:not(.unstyled)",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "margin-right",
        "value": "auto",
        "important": false
      }
    ]
  },
  {
    "selector": "[dir=rtl] label.field-label:not(.unstyled)",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "margin-left",
        "value": "auto",
        "important": false
      }
    ]
  },
  {
    "selector": "label.field-label:not(.unstyled) .required",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "color",
        "value": "var(--theme-error-500)",
        "important": false
      }
    ]
  },
  {
    "selector": "[dir=ltr] label.field-label:not(.unstyled) .required",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "margin-left",
        "value": "5px",
        "important": false
      }
    ]
  },
  {
    "selector": "[dir=rtl] label.field-label:not(.unstyled) .required",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "margin-right",
        "value": "5px",
        "important": false
      }
    ]
  },
  {
    "selector": "[dir=ltr] .localized",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "margin-left",
        "value": "5px",
        "important": false
      }
    ]
  },
  {
    "selector": "[dir=rtl] .localized",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "margin-right",
        "value": "5px",
        "important": false
      }
    ]
  },
  {
    "selector": ".icon--check",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "height",
        "value": "1.5384615385rem",
        "important": false
      },
      {
        "property": "width",
        "value": "1.5384615385rem",
        "important": false
      }
    ]
  },
  {
    "selector": ".icon--check .stroke",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "fill",
        "value": "none",
        "important": false
      },
      {
        "property": "stroke",
        "value": "currentColor",
        "important": false
      },
      {
        "property": "stroke-width",
        "value": "2px",
        "important": false
      }
    ]
  },
  {
    "selector": ".icon--line",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "width",
        "value": "1.5384615385rem",
        "important": false
      },
      {
        "property": "height",
        "value": "1.5384615385rem",
        "important": false
      }
    ]
  },
  {
    "selector": ".icon--line .stroke",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "stroke",
        "value": "currentColor",
        "important": false
      },
      {
        "property": "stroke-width",
        "value": "1px",
        "important": false
      }
    ]
  },
  {
    "selector": ".id-label",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "font-size",
        "value": "16px",
        "important": false
      },
      {
        "property": "line-height",
        "value": "24px",
        "important": false
      },
      {
        "property": "font-weight",
        "value": "400",
        "important": false
      },
      {
        "property": "color",
        "value": "var(--theme-elevation-600)",
        "important": false
      },
      {
        "property": "background",
        "value": "var(--theme-elevation-100)",
        "important": false
      },
      {
        "property": "padding",
        "value": "4px 8px",
        "important": false
      },
      {
        "property": "border-radius",
        "value": "4px",
        "important": false
      },
      {
        "property": "display",
        "value": "inline-flex",
        "important": false
      },
      {
        "property": "width",
        "value": "fit-content",
        "important": false
      }
    ]
  },
  {
    "selector": ".render-title",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "display",
        "value": "inline-block",
        "important": false
      }
    ]
  },
  {
    "selector": ".render-title__id",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "vertical-align",
        "value": "middle",
        "important": false
      },
      {
        "property": "position",
        "value": "relative",
        "important": false
      }
    ]
  },
  {
    "selector": ".progress-bar",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "position",
        "value": "fixed",
        "important": false
      },
      {
        "property": "top",
        "value": "0",
        "important": false
      },
      {
        "property": "left",
        "value": "0",
        "important": false
      },
      {
        "property": "width",
        "value": "100%",
        "important": false
      },
      {
        "property": "height",
        "value": "2px",
        "important": false
      },
      {
        "property": "z-index",
        "value": "9999",
        "important": false
      },
      {
        "property": "opacity",
        "value": "1",
        "important": false
      }
    ]
  },
  {
    "selector": ".progress-bar__progress",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "height",
        "value": "100%",
        "important": false
      },
      {
        "property": "background-color",
        "value": "var(--theme-elevation-1000)",
        "important": false
      },
      {
        "property": "transition",
        "value": "width ease-in var(--transition-duration)",
        "important": false
      }
    ]
  },
  {
    "selector": ".progress-bar--fade-out",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "opacity",
        "value": "0",
        "important": false
      },
      {
        "property": "transition",
        "value": "opacity linear var(--transition-duration)",
        "important": false
      },
      {
        "property": "transition-delay",
        "value": "var(--transition-duration)",
        "important": false
      }
    ]
  }
]);
