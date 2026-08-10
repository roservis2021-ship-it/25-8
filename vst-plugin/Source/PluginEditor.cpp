#include "PluginEditor.h"

EchoDriftAudioProcessorEditor::EchoDriftAudioProcessorEditor (EchoDriftAudioProcessor& p)
    : AudioProcessorEditor (&p), processorRef (p)
{
    setupSlider (delayTimeSlider, delayTimeLabel, "Time");
    setupSlider (feedbackSlider, feedbackLabel, "Feedback");
    setupSlider (mixSlider, mixLabel, "Mix");
    setupSlider (toneSlider, toneLabel, "Tone");

    auto& apvts = processorRef.apvts;
    delayTimeAttachment = std::make_unique<SliderAttachment> (apvts, EchoDriftAudioProcessor::delayTimeParamId, delayTimeSlider);
    feedbackAttachment  = std::make_unique<SliderAttachment> (apvts, EchoDriftAudioProcessor::feedbackParamId, feedbackSlider);
    mixAttachment       = std::make_unique<SliderAttachment> (apvts, EchoDriftAudioProcessor::mixParamId, mixSlider);
    toneAttachment      = std::make_unique<SliderAttachment> (apvts, EchoDriftAudioProcessor::toneParamId, toneSlider);

    setSize (420, 260);
}

EchoDriftAudioProcessorEditor::~EchoDriftAudioProcessorEditor() = default;

void EchoDriftAudioProcessorEditor::setupSlider (juce::Slider& slider, juce::Label& label, const juce::String& text)
{
    slider.setSliderStyle (juce::Slider::RotaryHorizontalVerticalDrag);
    slider.setTextBoxStyle (juce::Slider::TextBoxBelow, false, 80, 20);
    addAndMakeVisible (slider);

    label.setText (text, juce::dontSendNotification);
    label.setJustificationType (juce::Justification::centred);
    label.attachToComponent (&slider, false);
    addAndMakeVisible (label);
}

void EchoDriftAudioProcessorEditor::paint (juce::Graphics& g)
{
    auto bounds = getLocalBounds().toFloat();
    juce::ColourGradient gradient (juce::Colour (0xff1b1f2a), bounds.getTopLeft(),
                                    juce::Colour (0xff05070c), bounds.getBottomRight(), false);
    g.setGradientFill (gradient);
    g.fillAll();

    g.setColour (juce::Colours::white);
    g.setFont (juce::FontOptions (20.0f, juce::Font::bold));
    g.drawText ("EchoDrift", getLocalBounds().removeFromTop (36), juce::Justification::centred);
}

void EchoDriftAudioProcessorEditor::resized()
{
    auto area = getLocalBounds().reduced (20);
    area.removeFromTop (36);

    const auto sliderWidth = area.getWidth() / 4;
    auto row = area.removeFromTop (area.getHeight());

    delayTimeSlider.setBounds (row.removeFromLeft (sliderWidth).reduced (10, 20));
    feedbackSlider.setBounds  (row.removeFromLeft (sliderWidth).reduced (10, 20));
    mixSlider.setBounds       (row.removeFromLeft (sliderWidth).reduced (10, 20));
    toneSlider.setBounds      (row.removeFromLeft (sliderWidth).reduced (10, 20));
}
