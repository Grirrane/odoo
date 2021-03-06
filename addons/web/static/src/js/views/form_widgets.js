odoo.define('web.form_widgets', function (require) {
"use strict";

var core = require('web.core');
var crash_manager = require('web.crash_manager');
var data = require('web.data');
var datepicker = require('web.datepicker');
var Dialog = require('web.Dialog');
var common = require('web.form_common');
var formats = require('web.formats');
var framework = require('web.framework');
var Model = require('web.Model');
var pyeval = require('web.pyeval');
var session = require('web.session');
var utils = require('web.utils');

var _t = core._t;
var QWeb = core.qweb;

var WidgetButton = common.FormWidget.extend({
    template: 'WidgetButton',
    init: function(field_manager, node) {
        node.attrs.type = node.attrs['data-button-type'];
        this.is_stat_button = /\boe_stat_button\b/.test(node.attrs['class']);
        this.icon_class = node.attrs.icon && "stat_button_icon fa " + node.attrs.icon + " fa-fw";
        this._super(field_manager, node);
        this.force_disabled = false;
        this.string = (this.node.attrs.string || '').replace(/_/g, '');
        if (JSON.parse(this.node.attrs.default_focus || "0")) {
            // TODO fme: provide enter key binding to widgets
            this.view.default_focus_button = this;
        }
        if (this.node.attrs.icon && (! /\//.test(this.node.attrs.icon))) {
            this.node.attrs.icon = '/web/static/src/img/icons/' + this.node.attrs.icon + '.png';
        }
    },
    start: function() {
        this._super.apply(this, arguments);
        this.view.on('view_content_has_changed', this, this.check_disable);
        this.check_disable();
        this.$el.click(this.on_click);
        if (this.node.attrs.help || session.debug) {
            this.do_attach_tooltip();
        }
        this.setupFocus(this.$el);
    },
    on_click: function() {
        var self = this;
        this.force_disabled = true;
        this.check_disable();
        this.execute_action().always(function() {
            self.force_disabled = false;
            self.check_disable();
        });
    },
    execute_action: function() {
        var self = this;
        var exec_action = function() {
            if (self.node.attrs.confirm) {
                var def = $.Deferred();
                var dialog = new Dialog(this, {
                    title: _t('Confirm'),
                    buttons: [
                        {text: _t("Cancel"), click: function() {
                                this.parents('.modal').modal('hide');
                            }
                        },
                        {text: _t("Ok"), click: function() {
                                var self2 = this;
                                self.on_confirmed().always(function() {
                                    self2.parents('.modal').modal('hide');
                                });
                            }
                        }
                    ],
                }, $('<div/>').text(self.node.attrs.confirm)).open();
                dialog.on("closing", null, function() {def.resolve();});
                return def.promise();
            } else {
                return self.on_confirmed();
            }
        };
        if (!this.node.attrs.special) {
            return this.view.recursive_save().then(exec_action);
        } else {
            return exec_action();
        }
    },
    on_confirmed: function() {
        var self = this;

        var context = this.build_context();
        return this.view.do_execute_action(
            _.extend({}, this.node.attrs, {context: context}),
            this.view.dataset, this.view.datarecord.id, function (reason) {
                if (!_.isObject(reason)) {
                    self.view.recursive_reload();
                }
            });
    },
    check_disable: function() {
        var disabled = (this.force_disabled || !this.view.is_interactible_record());
        this.$el.prop('disabled', disabled);
        this.$el.css('color', disabled ? 'grey' : '');
    }
});

var FieldChar = common.AbstractField.extend(common.ReinitializeFieldMixin, {
    template: 'FieldChar',
    widget_class: 'oe_form_field_char',
    events: {
        'change input': 'store_dom_value',
    },
    init: function (field_manager, node) {
        this._super(field_manager, node);
        this.password = this.node.attrs.password === 'True' || this.node.attrs.password === '1';
    },
    initialize_content: function() {
        this.setupFocus(this.$('input'));
    },
    store_dom_value: function () {
        if (!this.get('effective_readonly')
                && this.$('input').length
                && this.is_syntax_valid()) {
            this.internal_set_value(
                this.parse_value(
                    this.$('input').val()));
        }
    },
    commit_value: function () {
        this.store_dom_value();
        return this._super();
    },
    render_value: function() {
        var show_value = this.format_value(this.get('value'), '');
        if (!this.get("effective_readonly")) {
            this.$el.find('input').val(show_value);
        } else {
            if (this.password) {
                show_value = new Array(show_value.length + 1).join('*');
            }
            this.$(".oe_form_char_content").text(show_value);
        }
    },
    is_syntax_valid: function() {
        if (!this.get("effective_readonly") && this.$("input").size() > 0) {
            try {
                this.parse_value(this.$('input').val(), '');
                return true;
            } catch(e) {
                return false;
            }
        }
        return true;
    },
    parse_value: function(val, def) {
        return formats.parse_value(val, this, def);
    },
    format_value: function(val, def) {
        return formats.format_value(val, this, def);
    },
    is_false: function() {
        return this.get('value') === '' || this._super();
    },
    focus: function() {
        var input = this.$('input:first')[0];
        return input ? input.focus() : false;
    },
    set_dimensions: function (height, width) {
        this._super(height, width);
        this.$('input').css({
            height: height,
            width: width
        });
    }
});

var KanbanSelection = FieldChar.extend({
    init: function (field_manager, node) {
        this._super(field_manager, node);
    },
    start: function () {
        var self = this;
        this.states = [];
        this._super.apply(this, arguments);
        // hook on form view content changed: recompute the states, because it may be related to the current stage
        this.getParent().on('view_content_has_changed', self, function () {
            self.render_value();
        });
    },
    prepare_dropdown_selection: function() {
        var self = this;
        var _data = [];
        var fetch_stage;
        var selection = this.field.selection || [];
        var stage_id = _.isArray(this.view.datarecord.stage_id) ? this.view.datarecord.stage_id[0] : this.view.datarecord.stage_id;
        var legend_field = this.options && this.options.states_legend_field || false;
        var fields_to_read = _.map(
            this.options && this.options.states_legend || {},
            function (value, key, list) { return value; });
        if (legend_field && fields_to_read && stage_id) {
            fetch_stage = new data.DataSet(
                this,
                self.view.fields[legend_field].field.relation).read_ids([stage_id],
                fields_to_read);
        }
        else { fetch_stage = $.Deferred().resolve(false); }
        return $.when(fetch_stage).then(function (stage_data) {
            _.map(selection, function(res) {
                var value = {
                    'name': res[0],
                    'tooltip': res[1],
                    'state_name': res[1],
                };
                if (stage_data && stage_data[0][self.options.states_legend[res[0]]]) {
                    value['state_name'] = stage_data[0][self.options.states_legend[res[0]]];
                    value['tooltip'] = stage_data[0][self.options.states_legend[res[0]]];
                }
                if (res[0] == 'normal') { value['state_class'] = 'oe_kanban_status'; }
                else if (res[0] == 'done') { value['state_class'] = 'oe_kanban_status oe_kanban_status_green'; }
                else { value['state_class'] = 'oe_kanban_status oe_kanban_status_red'; }
                _data.push(value);
            });
            return _data;
        });
    },
    render_value: function() {
        var self = this;
        var dd_fetched = this.prepare_dropdown_selection();
        return $.when(dd_fetched).then(function (states) {
            self.states = states;
            self.$el.html(QWeb.render("KanbanSelection", {'widget': self}));
            self.$el.find('li').on('click', self.set_kanban_selection.bind(self));
        });
    },
    /* setting the value: in view mode, perform an asynchronous call and reload
    the form view; in edit mode, use set_value to save the new value that will
    be written when saving the record. */
    set_kanban_selection: function (ev) {
        var self = this;
        var li = $(ev.target).closest('li');
        if (li.length) {
            var value = String(li.data('value'));
            if (this.view.get('actual_mode') == 'view') {
                var write_values = {};
                write_values[self.name] = value;
                return this.view.dataset._model.call(
                    'write', [
                        [this.view.datarecord.id],
                        write_values,
                        self.view.dataset.get_context()
                    ]).done(self.reload_record.bind(self));
            }
            else {
                return this.set_value(value);
            }
        }
    },
    reload_record: function() {
        this.view.reload();
    },
});

var Priority = FieldChar.extend({
    init: function (field_manager, node) {
        this._super(field_manager, node);
    },
    prepare_priority: function() {
        var self = this;
        var selection = this.field.selection || [];
        var init_value = selection && selection[0][0] || 0;
        var data = _.map(selection.slice(1), function(element, index) {
            var value = {
                'value': element[0],
                'name': element[1],
                'click_value': element[0],
            };
            if (index === 0 && self.get('value') === element[0]) {
                value['click_value'] = init_value;
            }
            return value;
        });
        return data;
    },
    render_value: function() {
        this.priorities = this.prepare_priority();
        this.$el.html(QWeb.render("Priority", {'widget': this}));
        if (!this.get('readonly')){
            this.$el.find('li').on('click', this.set_priority.bind(this));
        }
    },
    /* setting the value: in view mode, perform an asynchronous call and reload
    the form view; in edit mode, use set_value to save the new value that will
    be written when saving the record. */
    set_priority: function (ev) {
        var self = this;
        var li = $(ev.target).closest('li');
        if (li.length) {
            var value = String(li.data('value'));
            if (this.view.get('actual_mode') == 'view') {
                var write_values = {};
                write_values[self.name] = value;
                return this.view.dataset._model.call(
                    'write', [
                        [this.view.datarecord.id],
                        write_values,
                        self.view.dataset.get_context()
                    ]).done(self.reload_record.bind(self));
            }
            else {
                return this.set_value(value);
            }
        }

    },
    reload_record: function() {
        this.view.reload();
    },
});

var FieldID = FieldChar.extend({
    process_modifiers: function () {
        this._super();
        this.set({ readonly: true });
    },
});

var FieldEmail = FieldChar.extend({
    template: 'FieldEmail',
    initialize_content: function() {
        this._super();
        var $button = this.$el.find('button');
        $button.click(this.on_button_clicked);
        this.setupFocus($button);
    },
    render_value: function() {
        if (!this.get("effective_readonly")) {
            this._super();
        } else {
            this.$el.find('a')
                    .attr('href', 'mailto:' + this.get('value'))
                    .text(this.get('value') || '');
        }
    },
    on_button_clicked: function() {
        if (!this.get('value') || !this.is_syntax_valid()) {
            this.do_warn(_t("E-mail Error"), _t("Can't send email to invalid e-mail address"));
        } else {
            location.href = 'mailto:' + this.get('value');
        }
    }
});

var FieldUrl = FieldChar.extend({
    template: 'FieldUrl',
    initialize_content: function() {
        this._super();
        var $button = this.$el.find('button');
        $button.click(this.on_button_clicked);
        this.setupFocus($button);
    },
    render_value: function() {
        if (!this.get("effective_readonly")) {
            this._super();
        } else {
            var tmp = this.get('value');
            var s = /(\w+):(.+)|^\.{0,2}\//.exec(tmp);
            if (!s) {
                tmp = "http://" + this.get('value');
            }
            var text = this.get('value') ? this.node.attrs.text || tmp : '';
            this.$el.find('a').attr('href', tmp).text(text);
        }
    },
    on_button_clicked: function() {
        if (!this.get('value')) {
            this.do_warn(_t("Resource Error"), _t("This resource is empty"));
        } else {
            var url = $.trim(this.get('value'));
            if(/^www\./i.test(url))
                url = 'http://'+url;
            window.open(url);
        }
    }
});

var FieldFloat = FieldChar.extend({
    is_field_number: true,
    widget_class: 'oe_form_field_float',
    init: function (field_manager, node) {
        this._super(field_manager, node);
        this.internal_set_value(0);
        if (this.node.attrs.digits) {
            this.digits = this.node.attrs.digits;
        } else {
            this.digits = this.field.digits;
        }
    },
    set_value: function(value_) {
        if (value_ === false || value_ === undefined) {
            // As in GTK client, floats default to 0
            value_ = 0;
        }
        if (this.digits !== undefined && this.digits.length === 2) {
            value_ = utils.round_decimals(value_, this.digits[1]);
        }        
        this._super.apply(this, [value_]);
    },
    focus: function () {
        var $input = this.$('input:first');
        return $input.length ? $input.select() : false;
    }
});

var FieldCharDomain = common.AbstractField.extend(common.ReinitializeFieldMixin, {
    render_value: function() {
        var self = this;
        this.$el.html(QWeb.render("FieldCharDomain", {widget: this}));
        if (this.get('value')) {
            var model = this.options.model || this.field_manager.get_field_value(this.options.model_field);
            var domain = pyeval.eval('domain', this.get('value'));
            var ds = new data.DataSetStatic(self, model, self.build_context());
            ds.call('search_count', [domain]).then(function (results) {
                $('.oe_domain_count', self.$el).text(results + ' records selected');
                if (self.get('effective_readonly')) {
                    $('button span', self.$el).text(' See selection');
                }
                else {
                    $('button span', self.$el).text(' Change selection');
                }
            });
        } else {
            $('.oe_domain_count', this.$el).text('0 record selected');
            $('button span', this.$el).text(' Select records');
        }
        this.$('.select_records').on('click', self.on_click);
    },
    on_click: function(event) {
        event.preventDefault();
        var self = this;
        var model = this.options.model || this.field_manager.get_field_value(this.options.model_field);

        var options = {
                title: this.get('effective_readonly') ? 'Selected records' : 'Select records...',
                readonly: this.get('effective_readonly'),
                disable_multiple_selection: this.get('effective_readonly'),
                no_create: this.get('effective_readonly'),
            };
        var domain = this.get('value');
        var popup = new common.DomainEditorPopup(this);
        popup.select_element(model, options, domain, {});
        popup.on("elements_selected", self, function(selected_ids) {
            if (!self.get('effective_readonly')) {
                self.set_value(popup.get_domain(selected_ids));
            }
        });
    },
});

var FieldDatetime = common.AbstractField.extend(common.ReinitializeFieldMixin, {
    template: "FieldDatetime",
    build_widget: function() {
        return new datepicker.DateTimeWidget(this);
    },
    destroy_content: function() {
        if (this.datewidget) {
            this.datewidget.destroy();
            this.datewidget = undefined;
        }
    },
    initialize_content: function() {
        if (!this.get("effective_readonly")) {
            this.datewidget = this.build_widget();
            this.datewidget.on('datetime_changed', this, _.bind(function() {
                this.internal_set_value(this.datewidget.get_value());
            }, this));
            this.datewidget.appendTo(this.$el);
            this.setupFocus(this.datewidget.$input);
        }
    },
    render_value: function() {
        if (!this.get("effective_readonly")) {
            this.datewidget.set_value(this.get('value'));
        } else {
            this.$el.text(formats.format_value(this.get('value'), this, ''));
        }
    },
    is_syntax_valid: function() {
        if (!this.get("effective_readonly") && this.datewidget) {
            return this.datewidget.is_valid_();
        }
        return true;
    },
    is_false: function() {
        return this.get('value') === '' || this._super();
    },
    focus: function() {
        var input = this.datewidget && this.datewidget.$input[0];
        return input ? input.focus() : false;
    },
    set_dimensions: function (height, width) {
        this._super(height, width);
        if (!this.get("effective_readonly")) {
            this.datewidget.$input.css('height', height);
        }
    }
});

var FieldDate = FieldDatetime.extend({
    template: "FieldDate",
    build_widget: function() {
        return new datepicker.DateWidget(this);
    }
});

var FieldText = common.AbstractField.extend(common.ReinitializeFieldMixin, {
    template: 'FieldText',
    events: {
        'keyup': function (e) {
            if (e.which === $.ui.keyCode.ENTER) {
                e.stopPropagation();
            }
        },
        'keypress': function (e) {
            if (e.which === $.ui.keyCode.ENTER) {
                e.stopPropagation();
            }
        },
        'change textarea': 'store_dom_value',
    },
    initialize_content: function() {
        if (! this.get("effective_readonly")) {
            this.$textarea = this.$el.find('textarea');
            this.auto_sized = false;
            this.default_height = this.$textarea.css('height');
            if (this.default_height === '0px') this.default_height = '90px';
            if (this.get("effective_readonly")) {
                this.$textarea.attr('disabled', 'disabled');
            }
            this.setupFocus(this.$textarea);
        } else {
            this.$textarea = undefined;
        }
    },
    commit_value: function () {
        if (! this.get("effective_readonly") && this.$textarea) {
            this.store_dom_value();
        }
        return this._super();
    },
    store_dom_value: function () {
        this.internal_set_value(formats.parse_value(this.$textarea.val(), this));
    },
    render_value: function() {
        if (! this.get("effective_readonly")) {
            var show_value = formats.format_value(this.get('value'), this, '');
            if (show_value === '') {
                this.$textarea.css('height', parseInt(this.default_height, 10)+"px");
            }
            this.$textarea.val(show_value);
            if (! this.auto_sized) {
                this.auto_sized = true;
                this.$textarea.autosize();
            } else {
                this.$textarea.trigger("autosize");
            }
        } else {
            var txt = this.get("value") || '';
            this.$(".oe_form_text_content").text(txt);
        }
    },
    is_syntax_valid: function() {
        if (!this.get("effective_readonly") && this.$textarea) {
            try {
                formats.parse_value(this.$textarea.val(), this, '');
                return true;
            } catch(e) {
                return false;
            }
        }
        return true;
    },
    is_false: function() {
        return this.get('value') === '' || this._super();
    },
    focus: function($el) {
        var input = !this.get("effective_readonly") && this.$textarea && this.$textarea[0];
        return input ? input.focus() : false;
    },
    set_dimensions: function (height, width) {
        this._super(height, width);
        if (!this.get("effective_readonly") && this.$textarea) {
            this.$textarea.css({
                width: width,
                minHeight: height
            });
        }
    },
});

/**
 * FieldTextHtml Widget
 * Intended for FieldText widgets meant to display HTML content. This
 * widget will instantiate the CLEditor (see cleditor in static/src/lib)
 * To find more information about CLEditor configutation: go to
 * http://premiumsoftware.net/cleditor/docs/GettingStarted.html
 */
var FieldTextHtml = common.AbstractField.extend(common.ReinitializeFieldMixin, {
    template: 'FieldTextHtml',
    init: function() {
        this._super.apply(this, arguments);
    },
    initialize_content: function() {
        var self = this;
        if (! this.get("effective_readonly")) {
            self._updating_editor = false;
            this.$textarea = this.$el.find('textarea');
            var width = ((this.node.attrs || {}).editor_width || 'calc(100% - 4px)');
            var height = ((this.node.attrs || {}).editor_height || 250);
            this.$textarea.cleditor({
                width:      width, // width not including margins, borders or padding
                height:     height, // height not including margins, borders or padding
                controls:   // controls to add to the toolbar
                            "bold italic underline strikethrough " +
                            "| removeformat | bullets numbering | outdent " +
                            "indent | link unlink | source",
                bodyStyle:  // style to assign to document body contained within the editor
                            "margin:4px; color:#4c4c4c; font-size:13px; font-family:'Lucida Grande',Helvetica,Verdana,Arial,sans-serif; cursor:text"
            });
            this.$cleditor = this.$textarea.cleditor()[0];
            this.$cleditor.change(function() {
                if (! self._updating_editor) {
                    self.$cleditor.updateTextArea();
                    self.internal_set_value(self.$textarea.val());
                }
            });
            if (this.field.translate) {
                var $img = $('<img class="oe_field_translate oe_input_icon" src="/web/static/src/img/icons/terp-translate.png" width="16" height="16" border="0"/>')
                    .click(this.on_translate);
                this.$cleditor.$toolbar.append($img);
            }
        }
    },
    render_value: function() {
        if (! this.get("effective_readonly")) {
            this.$textarea.val(this.get('value') || '');
            this._updating_editor = true;
            this.$cleditor.updateFrame();
            this._updating_editor = false;
        } else {
            this.$el.html(this.get('value'));
        }
    },
});

var FieldBoolean = common.AbstractField.extend({
    template: 'FieldBoolean',
    start: function() {
        var self = this;
        this.$checkbox = $("input", this.$el);
        this.setupFocus(this.$checkbox);
        this.$el.click(_.bind(function() {
            this.internal_set_value(this.$checkbox.is(':checked'));
        }, this));
        var check_readonly = function() {
            self.$checkbox.prop('disabled', self.get("effective_readonly"));
            self.click_disabled_boolean();
        };
        this.on("change:effective_readonly", this, check_readonly);
        check_readonly.call(this);
        this._super.apply(this, arguments);
    },
    render_value: function() {
        this.$checkbox[0].checked = this.get('value');
    },
    focus: function() {
        var input = this.$checkbox && this.$checkbox[0];
        return input ? input.focus() : false;
    },
    click_disabled_boolean: function(){
        var $disabled = this.$el.find('input[type=checkbox]:disabled');
        $disabled.each(function (){
            $(this).next('div').remove();
            $(this).closest("span").append($('<div class="boolean"></div>'));
        });
    }
});

/**
    The progressbar field expect a float from 0 to 100.
*/
var FieldProgressBar = common.AbstractField.extend({
    template: 'FieldProgressBar',
    render_value: function() {
        this.$el.progressbar({
            value: this.get('value') || 0,
            disabled: this.get("effective_readonly")
        });
        var formatted_value = formats.format_value(this.get('value') || 0, { type : 'float' });
        this.$('span').html(formatted_value + '%');
    }
});

/**
    The PercentPie field expect a float from 0 to 100.
*/
var FieldPercentPie = common.AbstractField.extend({
    template: 'FieldPercentPie',

    render_value: function() {
        var value = this.get('value'),
            formatted_value = Math.round(value || 0) + '%',
            svg = this.$('svg')[0];

        svg.innerHTML = "";
        nv.addGraph(function() {
            var width = 42, height = 42;
            var chart = nv.models.pieChart()
                .width(width)
                .height(height)
                .margin({top: 0, right: 0, bottom: 0, left: 0})
                .donut(true) 
                .showLegend(false)
                .showLabels(false)
                .tooltips(false)
                .color(['#7C7BAD','#DDD'])
                .donutRatio(0.62);
   
            d3.select(svg)
                .datum([{'x': 'value', 'y': value}, {'x': 'complement', 'y': 100 - value}])
                .transition()
                .call(chart)
                .attr('style', 'width: ' + width + 'px; height:' + height + 'px;');

            d3.select(svg)
                .append("text")
                .attr({x: width/2, y: height/2 + 3, 'text-anchor': 'middle'})
                .style({"font-size": "10px", "font-weight": "bold"})
                .text(formatted_value);

            return chart;
        });
   
    }
});

/**
    The FieldBarChart expectsa list of values (indeed)
*/
var FieldBarChart = common.AbstractField.extend({
    template: 'FieldBarChart',

    render_value: function() {
        var value = JSON.parse(this.get('value'));
        var svg = this.$('svg')[0];
        svg.innerHTML = "";
        nv.addGraph(function() {
            var width = 34, height = 34;
            var chart = nv.models.discreteBarChart()
                .x(function (d) { return d.tooltip; })
                .y(function (d) { return d.value; })
                .width(width)
                .height(height)
                .margin({top: 0, right: 0, bottom: 0, left: 0})
                .tooltips(false)
                .showValues(false)
                .transitionDuration(350)
                .showXAxis(false)
                .showYAxis(false);
   
            d3.select(svg)
                .datum([{key: 'values', values: value}])
                .transition()
                .call(chart)
                .attr('style', 'width: ' + (width + 4) + 'px; height: ' + (height + 8) + 'px;');

            nv.utils.windowResize(chart.update);

            return chart;
        });
   
    }
});


var FieldSelection = common.AbstractField.extend(common.ReinitializeFieldMixin, {
    template: 'FieldSelection',
    events: {
        'change select': 'store_dom_value',
    },
    init: function(field_manager, node) {
        this._super(field_manager, node);
        this.set("value", false);
        this.set("values", []);
        this.records_orderer = new utils.DropMisordered();
        this.field_manager.on("view_content_has_changed", this, function() {
            var domain = new data.CompoundDomain(this.build_domain()).eval();
            if (! _.isEqual(domain, this.get("domain"))) {
                this.set("domain", domain);
            }
        });
    },
    initialize_field: function() {
        common.ReinitializeFieldMixin.initialize_field.call(this);
        this.on("change:domain", this, this.query_values);
        this.set("domain", new data.CompoundDomain(this.build_domain()).eval());
        this.on("change:values", this, this.render_value);
    },
    query_values: function() {
        var self = this;
        var def;
        if (this.field.type === "many2one") {
            var model = new Model(this.field.relation);
            def = model.call("name_search", ['', this.get("domain")], {"context": this.build_context()});
        } else {
            var values = _.reject(this.field.selection, function (v) { return v[0] === false && v[1] === ''; });
            def = $.when(values);
        }
        this.records_orderer.add(def).then(function(values) {
            if (! _.isEqual(values, self.get("values"))) {
                self.set("values", values);
            }
        });
    },
    initialize_content: function() {
        // Flag indicating whether we're in an event chain containing a change
        // event on the select, in order to know what to do on keyup[RETURN]:
        // * If the user presses [RETURN] as part of changing the value of a
        //   selection, we should just let the value change and not let the
        //   event broadcast further (e.g. to validating the current state of
        //   the form in editable list view, which would lead to saving the
        //   current row or switching to the next one)
        // * If the user presses [RETURN] with a select closed (side-effect:
        //   also if the user opened the select and pressed [RETURN] without
        //   changing the selected value), takes the action as validating the
        //   row
        var ischanging = false;
        var $select = this.$el.find('select')
            .change(function () { ischanging = true; })
            .click(function () { ischanging = false; })
            .keyup(function (e) {
                if (e.which !== 13 || !ischanging) { return; }
                e.stopPropagation();
                ischanging = false;
            });
        this.setupFocus($select);
    },
    commit_value: function () {
        this.store_dom_value();
        return this._super();
    },
    store_dom_value: function () {
        if (!this.get('effective_readonly') && this.$('select').length) {
            var val = JSON.parse(this.$('select').val());
            this.internal_set_value(val);
        }
    },
    set_value: function(value_) {
        value_ = value_ === null ? false : value_;
        value_ = value_ instanceof Array ? value_[0] : value_;
        this._super(value_);
    },
    render_value: function() {
        var values = this.get("values");
        values =  [[false, this.node.attrs.placeholder || '']].concat(values);
        var found = _.find(values, function(el) { return el[0] === this.get("value"); }, this);
        if (! found) {
            found = [this.get("value"), _t('Unknown')];
            values = [found].concat(values);
        }
        if (! this.get("effective_readonly")) {
            this.$().html(QWeb.render("FieldSelectionSelect", {widget: this, values: values}));
            this.$("select").val(JSON.stringify(found[0]));
        } else {
            this.$el.text(found[1]);
        }
    },
    focus: function() {
        var input = this.$('select:first')[0];
        return input ? input.focus() : false;
    },
    set_dimensions: function (height, width) {
        this._super(height, width);
        this.$('select').css({
            height: height,
            width: width
        });
    }
});

var FieldRadio = common.AbstractField.extend(common.ReinitializeFieldMixin, {
    template: 'FieldRadio',
    events: {
        'click input': 'click_change_value'
    },
    init: function(field_manager, node) {
        /* Radio button widget: Attributes options:
        * - "horizontal" to display in column
        * - "no_radiolabel" don't display text values
        */
        this._super(field_manager, node);
        this.selection = _.clone(this.field.selection) || [];
        this.domain = false;
        this.uniqueId = _.uniqueId("radio");
    },
    initialize_content: function () {
        this.on("change:effective_readonly", this, this.render_value);
        this.field_manager.on("view_content_has_changed", this, this.get_selection);
        this.get_selection();
    },
    click_change_value: function (event) {
        var val = $(event.target).val();
        val = this.field.type == "selection" ? val : +val;
        if (val !== this.get_value()) {
            this.set_value(val);
        }
    },
    /** Get the selection and render it
     *  selection: [[identifier, value_to_display], ...]
     *  For selection fields: this is directly given by this.field.selection
     *  For many2one fields:  perform a search on the relation of the many2one field
     */
    get_selection: function() {
        var self = this;
        var selection = [];
        var def = $.Deferred();
        if (self.field.type == "many2one") {
            var domain = pyeval.eval('domain', this.build_domain()) || [];
            if (! _.isEqual(self.domain, domain)) {
                self.domain = domain;
                var ds = new data.DataSetStatic(self, self.field.relation, self.build_context());
                ds.call('search', [self.domain])
                    .then(function (records) {
                        ds.name_get(records).then(function (records) {
                            selection = records;
                            def.resolve();
                        });
                    });
            } else {
                selection = self.selection;
                def.resolve();
            }
        }
        else if (self.field.type == "selection") {
            selection = self.field.selection || [];
            def.resolve();
        }
        return def.then(function () {
            if (! _.isEqual(selection, self.selection)) {
                self.selection = _.clone(selection);
                self.renderElement();
                self.render_value();
            }
        });
    },
    set_value: function (value_) {
        if (this.field.type == "selection") {
            value_ = _.find(this.field.selection, function (sel) { return sel[0] == value_;});
        }
        else if (!this.selection.length) {
            this.selection = [value_];
        }

        this._super(value_);
    },
    get_value: function () {
        var value = this.get('value');
        return value instanceof Array ? value[0] : value;
    },
    render_value: function () {
        var self = this;
        this.$el.toggleClass("oe_readonly", this.get('effective_readonly'));
        this.$("input").filter(function () {return this.value == self.get_value();}).prop("checked", true);
        this.$(".oe_radio_readonly").text(this.get('value') ? this.get('value')[1] : "");
    }
});

var FieldReference = common.AbstractField.extend(common.ReinitializeFieldMixin, {
    template: 'FieldReference',
    init: function(field_manager, node) {
        this._super(field_manager, node);
        this.reference_ready = true;
    },
    destroy_content: function() {
        if (this.fm) {
            this.fm.destroy();
            this.fm = undefined;
        }
    },
    initialize_content: function() {
        var self = this;
        var fm = new common.DefaultFieldManager(this);
        this.fm = fm;
        fm.extend_field_desc({
            "selection": {
                selection: this.field_manager.get_field_desc(this.name).selection,
                type: "selection",
            },
            "m2o": {
                relation: null,
                type: "many2one",
            },
        });
        this.selection = new FieldSelection(fm, { attrs: {
            name: 'selection',
            modifiers: JSON.stringify({readonly: this.get('effective_readonly')}),
        }});
        this.selection.on("change:value", this, this.on_selection_changed);
        this.selection.appendTo(this.$(".oe_form_view_reference_selection"));
        this.selection
            .on('focused', null, function () {self.trigger('focused');})
            .on('blurred', null, function () {self.trigger('blurred');});

        var FieldMany2One = core.form_widget_registry.get('many2one');
        this.m2o = new FieldMany2One(fm, { attrs: {
            name: 'Referenced Document',
            modifiers: JSON.stringify({readonly: this.get('effective_readonly')}),
        }});
        this.m2o.on("change:value", this, this.data_changed);
        this.m2o.appendTo(this.$(".oe_form_view_reference_m2o"));
        this.m2o
            .on('focused', null, function () {self.trigger('focused');})
            .on('blurred', null, function () {self.trigger('blurred');});
    },
    on_selection_changed: function() {
        if (this.reference_ready) {
            this.internal_set_value([this.selection.get_value(), false]);
            this.render_value();
        }
    },
    data_changed: function() {
        if (this.reference_ready) {
            this.internal_set_value([this.selection.get_value(), this.m2o.get_value()]);
        }
    },
    set_value: function(val) {
        if (val) {
            val = val.split(',');
            val[0] = val[0] || false;
            val[1] = val[0] ? (val[1] ? parseInt(val[1], 10) : val[1]) : false;
        }
        this._super(val || [false, false]);
    },
    get_value: function() {
        return this.get('value')[0] && this.get('value')[1] ? (this.get('value')[0] + ',' + this.get('value')[1]) : false;
    },
    render_value: function() {
        this.reference_ready = false;
        if (!this.get("effective_readonly")) {
            this.selection.set_value(this.get('value')[0]);
        }
        this.m2o.field.relation = this.get('value')[0];
        this.m2o.set_value(this.get('value')[1]);
        this.m2o.$el.toggle(!!this.get('value')[0]);
        this.reference_ready = true;
    },
});

var FieldBinary = common.AbstractField.extend(common.ReinitializeFieldMixin, {
    init: function(field_manager, node) {
        var self = this;
        this._super(field_manager, node);
        this.binary_value = false;
        this.useFileAPI = !!window.FileReader;
        this.max_upload_size = 25 * 1024 * 1024; // 25Mo
        if (!this.useFileAPI) {
            this.fileupload_id = _.uniqueId('oe_fileupload');
            $(window).on(this.fileupload_id, function() {
                var args = [].slice.call(arguments).slice(1);
                self.on_file_uploaded.apply(self, args);
            });
        }
    },
    stop: function() {
        if (!this.useFileAPI) {
            $(window).off(this.fileupload_id);
        }
        this._super.apply(this, arguments);
    },
    initialize_content: function() {
        var self= this;
        this.$el.find('input.oe_form_binary_file').change(this.on_file_change);
        this.$el.find('button.oe_form_binary_file_save').click(this.on_save_as);
        this.$el.find('.oe_form_binary_file_clear').click(this.on_clear);
        this.$el.find('.oe_form_binary_file_edit').click(function(event){
            self.$el.find('input.oe_form_binary_file').click();
        });
    },
    on_file_change: function(e) {
        var self = this;
        var file_node = e.target;
        if ((this.useFileAPI && file_node.files.length) || (!this.useFileAPI && $(file_node).val() !== '')) {
            if (this.useFileAPI) {
                var file = file_node.files[0];
                if (file.size > this.max_upload_size) {
                    var msg = _t("The selected file exceed the maximum file size of %s.");
                    core.bus.trigger('display_notification_warning', _t("File upload"), _.str.sprintf(msg, utils.human_size(this.max_upload_size)));
                    return false;
                }
                var filereader = new FileReader();
                filereader.readAsDataURL(file);
                filereader.onloadend = function(upload) {
                    var data = upload.target.result;
                    data = data.split(',')[1];
                    self.on_file_uploaded(file.size, file.name, file.type, data);
                };
            } else {
                this.$el.find('form.oe_form_binary_form input[name=session_id]').val(this.session.session_id);
                this.$el.find('form.oe_form_binary_form').submit();
            }
            this.$el.find('.oe_form_binary_progress').show();
            this.$el.find('.oe_form_binary').hide();
        }
    },
    on_file_uploaded: function(size, name, content_type, file_base64) {
        if (size === false) {
            this.do_warn(_t("File Upload"), _t("There was a problem while uploading your file"));
            // TODO: use openerp web crashmanager
            console.warn("Error while uploading file : ", name);
        } else {
            this.filename = name;
            this.on_file_uploaded_and_valid.apply(this, arguments);
        }
        this.$el.find('.oe_form_binary_progress').hide();
        this.$el.find('.oe_form_binary').show();
    },
    on_file_uploaded_and_valid: function(size, name, content_type, file_base64) {
    },
    on_save_as: function(ev) {
        var value = this.get('value');
        if (!value) {
            this.do_warn(_t("Save As..."), _t("The field is empty, there's nothing to save !"));
            ev.stopPropagation();
        } else {
            framework.blockUI();
            var c = crash_manager;
            var filename_fieldname = this.node.attrs.filename;
            var filename_field = this.view.fields && this.view.fields[filename_fieldname];
            this.session.get_file({
                url: '/web/binary/saveas_ajax',
                data: {data: JSON.stringify({
                    model: this.view.dataset.model,
                    id: (this.view.datarecord.id || ''),
                    field: this.name,
                    filename_field: (filename_fieldname || ''),
                    data: utils.is_bin_size(value) ? null : value,
                    filename: filename_field ? filename_field.get('value') : null,
                    context: this.view.dataset.get_context()
                })},
                complete: framework.unblockUI,
                error: c.rpc_error.bind(c)
            });
            ev.stopPropagation();
            return false;
        }
    },
    set_filename: function(value) {
        var filename = this.node.attrs.filename;
        if (filename) {
            var tmp = {};
            tmp[filename] = value;
            this.field_manager.set_values(tmp);
        }
    },
    on_clear: function() {
        if (this.get('value') !== false) {
            this.binary_value = false;
            this.internal_set_value(false);
        }
        return false;
    }
});

var FieldBinaryFile = FieldBinary.extend({
    template: 'FieldBinaryFile',
    initialize_content: function() {
        this._super();
        if (this.get("effective_readonly")) {
            var self = this;
            this.$el.find('a').click(function(ev) {
                if (self.get('value')) {
                    self.on_save_as(ev);
                }
                return false;
            });
        }
    },
    render_value: function() {
        var show_value;
        if (!this.get("effective_readonly")) {
            if (this.node.attrs.filename) {
                show_value = this.view.datarecord[this.node.attrs.filename] || '';
            } else {
                show_value = (this.get('value') !== null && this.get('value') !== undefined && this.get('value') !== false) ? this.get('value') : '';
            }
            this.$el.find('input').eq(0).val(show_value);
        } else {
            this.$el.find('a').toggle(!!this.get('value'));
            if (this.get('value')) {
                show_value = _t("Download");
                if (this.view)
                    show_value += " " + (this.view.datarecord[this.node.attrs.filename] || '');
                this.$el.find('a').text(show_value);
            }
        }
    },
    on_file_uploaded_and_valid: function(size, name, content_type, file_base64) {
        this.binary_value = true;
        this.internal_set_value(file_base64);
        var show_value = name + " (" + utils.human_size(size) + ")";
        this.$el.find('input').eq(0).val(show_value);
        this.set_filename(name);
    },
    on_clear: function() {
        this._super.apply(this, arguments);
        this.$el.find('input').eq(0).val('');
        this.set_filename('');
    }
});

var FieldBinaryImage = FieldBinary.extend({
    template: 'FieldBinaryImage',
    placeholder: "/web/static/src/img/placeholder.png",
    render_value: function() {
        var self = this;
        var url;
        this.session = session;
        if (this.get('value') && !utils.is_bin_size(this.get('value'))) {
            url = 'data:image/png;base64,' + this.get('value');
        } else if (this.get('value')) {
            var id = JSON.stringify(this.view.datarecord.id || null);
            var field = this.name;
            if (this.options.preview_image)
                field = this.options.preview_image;
            url = session.url('/web/binary/image', {
                                        model: this.view.dataset.model,
                                        id: id,
                                        field: field,
                                        t: (new Date().getTime()),
            });
        } else {
            url = this.placeholder;
        }
        var $img = $(QWeb.render("FieldBinaryImage-img", { widget: this, url: url }));
        $($img).click(function(e) {
            if(self.view.get("actual_mode") == "view") {
                var $button = $(".oe_form_button_edit");
                $button.openerpBounce();
                e.stopPropagation();
            }
        });
        this.$el.find('> img').remove();
        this.$el.prepend($img);
        $img.load(function() {
            if (! self.options.size)
                return;
            $img.css("max-width", "" + self.options.size[0] + "px");
            $img.css("max-height", "" + self.options.size[1] + "px");
        });
        $img.on('error', function() {
            $img.attr('src', self.placeholder);
            core.bus.trigger('display_notification_warning', _t("Image"), _t("Could not display the selected image."));
        });
    },
    on_file_uploaded_and_valid: function(size, name, content_type, file_base64) {
        this.internal_set_value(file_base64);
        this.binary_value = true;
        this.render_value();
        this.set_filename(name);
    },
    on_clear: function() {
        this._super.apply(this, arguments);
        this.render_value();
        this.set_filename('');
    },
    set_value: function(value_){
        var changed = value_ !== this.get_value();
        this._super.apply(this, arguments);
        // By default, on binary images read, the server returns the binary size
        // This is possible that two images have the exact same size
        // Therefore we trigger the change in case the image value hasn't changed
        // So the image is re-rendered correctly
        if (!changed){
            this.trigger("change:value", this, {
                oldValue: value_,
                newValue: value_
            });
        }
    }
});

var FieldStatus = common.AbstractField.extend({
    template: "FieldStatus",
    init: function(field_manager, node) {
        this._super(field_manager, node);
        this.options.clickable = this.options.clickable || (this.node.attrs || {}).clickable || false;
        this.options.visible = this.options.visible || (this.node.attrs || {}).statusbar_visible || false;
        this.set({value: false});
        this.selection = {'unfolded': [], 'folded': []};
        this.set("selection", {'unfolded': [], 'folded': []});
        this.selection_dm = new utils.DropMisordered();
        this.dataset = new data.DataSetStatic(this, this.field.relation, this.build_context());
    },
    start: function() {
        this.field_manager.on("view_content_has_changed", this, this.calc_domain);
        this.calc_domain();
        this.on("change:value", this, this.get_selection);
        this.on("change:evaluated_selection_domain", this, this.get_selection);
        this.on("change:selection", this, function() {
            this.selection = this.get("selection");
            this.render_value();
        });
        this.get_selection();
        if (this.options.clickable) {
            this.$el.on('click','li[data-id]',this.on_click_stage);
        }
        if (this.$el.parent().is('header')) {
            this.$el.after('<div class="oe_clear"/>');
        }
        this._super();
    },
    set_value: function(value_) {
        if (value_ instanceof Array) {
            value_ = value_[0];
        }
        this._super(value_);
    },
    render_value: function() {
        var self = this;
        var content = QWeb.render("FieldStatus.content", {
            'widget': self, 
            'value_folded': _.find(self.selection.folded, function(i){return i[0] === self.get('value');})
        });
        self.$el.html(content);
    },
    calc_domain: function() {
        var d = pyeval.eval('domain', this.build_domain());
        var domain = []; //if there is no domain defined, fetch all the records

        if (d.length) {
            domain = ['|',['id', '=', this.get('value')]].concat(d);
        }

        if (! _.isEqual(domain, this.get("evaluated_selection_domain"))) {
            this.set("evaluated_selection_domain", domain);
        }
    },
    /** Get the selection and render it
     *  selection: [[identifier, value_to_display], ...]
     *  For selection fields: this is directly given by this.field.selection
     *  For many2one fields:  perform a search on the relation of the many2one field
     */
    get_selection: function() {
        var self = this;
        var selection_unfolded = [];
        var selection_folded = [];
        var fold_field = this.options.fold_field;

        var calculation = _.bind(function() {
            if (this.field.type == "many2one") {
                return self.get_distant_fields().then(function (fields) {
                    return new data.DataSetSearch(self, self.field.relation, self.build_context(), self.get("evaluated_selection_domain"))
                        .read_slice(_.union(_.keys(self.distant_fields), ['id']), {}).then(function (records) {
                            var ids = _.pluck(records, 'id');
                            return self.dataset.name_get(ids).then(function (records_name) {
                                _.each(records, function (record) {
                                    var name = _.find(records_name, function (val) {return val[0] == record.id;})[1];
                                    if (fold_field && record[fold_field] && record.id != self.get('value')) {
                                        selection_folded.push([record.id, name]);
                                    } else {
                                        selection_unfolded.push([record.id, name]);
                                    }
                                });
                            });
                        });
                    });
            } else {
                // For field type selection filter values according to
                // statusbar_visible attribute of the field. For example:
                // statusbar_visible="draft,open".
                var select = this.field.selection;
                for(var i=0; i < select.length; i++) {
                    var key = select[i][0];
                    if(key == this.get('value') || !this.options.visible || this.options.visible.indexOf(key) != -1) {
                        selection_unfolded.push(select[i]);
                    }
                }
                return $.when();
            }
        }, this);
        this.selection_dm.add(calculation()).then(function () {
            var selection = {'unfolded': selection_unfolded, 'folded': selection_folded};
            if (! _.isEqual(selection, self.get("selection"))) {
                self.set("selection", selection);
            }
        });
    },
    /*
     * :deprecated: this feature will probably be removed with OpenERP v8
     */
    get_distant_fields: function() {
        var self = this;
        if (! this.options.fold_field) {
            this.distant_fields = {};
        }
        if (this.distant_fields) {
            return $.when(this.distant_fields);
        }
        return new Model(self.field.relation).call("fields_get", [[this.options.fold_field]]).then(function(fields) {
            self.distant_fields = fields;
            return fields;
        });
    },
    on_click_stage: function (ev) {
        var self = this;
        var $li = $(ev.currentTarget);
        var val;
        if (this.field.type == "many2one") {
            val = parseInt($li.data("id"), 10);
        }
        else {
            val = $li.data("id");
        }
        if (val != self.get('value')) {
            this.view.recursive_save().done(function() {
                var change = {};
                change[self.name] = val;
                self.view.dataset.write(self.view.datarecord.id, change).done(function() {
                    self.view.reload();
                });
            });
        }
    },
});

var FieldMonetary = FieldFloat.extend({
    template: "FieldMonetary",
    widget_class: 'oe_form_field_float oe_form_field_monetary',
    init: function() {
        this._super.apply(this, arguments);
        this.set({"currency": false});
        var currency_field = (this.options && this.options.currency_field) || this.currency_field || 'currency_id';
        if (currency_field) {
            this.field_manager.on("field_changed:" + currency_field, this, function() {
                this.set({"currency": this.field_manager.get_field_value(currency_field)});
            });
        }
        this.on("change:currency", this, this.get_currency_info);
        this.get_currency_info();
    },
    start: function() {
        var tmp = this._super();
        this.on("change:currency_info", this, this.update);
        return tmp;
    },
    get_currency_info: function() {
        var self = this;
        if (this.get("currency") === false) {
            this.set({"currency_info": null});
            return;
        }
        return self.set({"currency_info": session.get_currency(self.get("currency"))});
    },
    update: function() {
        if (this.view.options.is_list_editable){
            return;
        } else {
            return this.reinitialize();
        }
    },
    get_digits_precision: function() {
        return this.node.attrs.digits || this.field.digits || (this.get('currency_info') && this.get('currency_info').digits);
     },
    parse_value: function(val, def) {
        return formats.parse_value(val, {type: "float", digits: this.get_digits_precision()}, def);
    },
    format_value: function(val, def) {
        return formats.format_value(val, {type: "float", digits: this.get_digits_precision()}, def);
    },
});

/**
    This widget is intended to be used on stat button numeric fields.  It will display
    the value   many2many and one2many. It is a read-only field that will 
    display a simple string "<value of field> <label of the field>"
*/
var StatInfo = common.AbstractField.extend({
    is_field_number: true,
    init: function() {
        this._super.apply(this, arguments);
        this.internal_set_value(0);
    },
    set_value: function(value_) {
        if (value_ === false || value_ === undefined) {
            value_ = 0;
        }
        this._super.apply(this, [value_]);
    },
    render_value: function() {
        var options = {
            value: this.get("value") || 0,
        };
        if (! this.node.attrs.nolabel) {
            if(this.options.label_field && this.view.datarecord[this.options.label_field]) {
                options.text = this.view.datarecord[this.options.label_field];
            }
            else {
                options.text = this.string;
            }
        }
        this.$el.html(QWeb.render("StatInfo", options));
    },

});

/**
    This widget is intended to be used on boolean fields. It toggles a button
    switching between a green bullet / gray bullet.
*/
var FieldToggleBoolean = common.AbstractField.extend({
    render_value: function () {
        this.icon = this.get_value() ? 'gtk-yes.png' : 'gtk-normal.png';
        this.$el.html(QWeb.render("FieldToggleBoolean", {'widget': this}));
        this.$('.oe_toggle_button').on('click', this.set_toggle_button.bind(this));
    },
    set_toggle_button: function () {
        var self = this;
        var toggle_value = this.get_value() === false ? true: false;
        if (this.view.get('actual_mode') == 'view') {
            var rec_values = {};
            rec_values[self.node.attrs.name] = toggle_value;
            return this.view.dataset._model.call(
                    'write', [
                        [this.view.datarecord.id],
                        rec_values,
                        self.view.dataset.get_context()
                    ]).done(function () { self.reload_record(); });
        }
        else {
            this.set_value(toggle_value);
        }
    },
    reload_record: function () {
        this.view.reload();
    },
});


/**
 * Registry of form fields, called by :js:`instance.web.FormView`.
 *
 * All referenced classes must implement FieldInterface. Those represent the classes whose instances
 * will substitute to the <field> tags as defined in OpenERP's views.
 */
core.form_widget_registry
    .add('char', FieldChar)
    .add('id', FieldID)
    .add('email', FieldEmail)
    .add('url', FieldUrl)
    .add('text',FieldText)
    .add('html', FieldTextHtml)
    .add('char_domain', FieldCharDomain)
    .add('date', FieldDate)
    .add('datetime', FieldDatetime)
    .add('selection', FieldSelection)
    .add('radio', FieldRadio)
    .add('reference', FieldReference)
    .add('boolean', FieldBoolean)
    .add('toggle_button', FieldToggleBoolean)
    .add('float', FieldFloat)
    .add('percentpie', FieldPercentPie)
    .add('barchart', FieldBarChart)
    .add('integer', FieldFloat)
    .add('float_time', FieldFloat)
    .add('progressbar', FieldProgressBar)
    .add('image', FieldBinaryImage)
    .add('binary', FieldBinaryFile)
    .add('statusbar', FieldStatus)
    .add('monetary', FieldMonetary)
    .add('priority', Priority)
    .add('kanban_state_selection', KanbanSelection)
    .add('statinfo', StatInfo);


/**
 * Registry of widgets usable in the form view that can substitute to any possible
 * tags defined in OpenERP's form views.
 *
 * Every referenced class should extend FormWidget.
 */
core.form_tag_registry.add('button', WidgetButton);

return {
    FieldChar: FieldChar,
};

});
